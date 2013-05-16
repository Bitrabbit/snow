var Q = require('q')
, _ = require('underscore')
, orders = module.exports = {}
, validate = require('./validate')
, activities = require('./activities')

orders.configure = function(app, conn, auth) {
    app.del('/v1/orders/:id', auth, orders.cancel.bind(orders, conn))
    app.post('/v1/orders', auth, orders.create.bind(orders, conn))
    app.get('/v1/orders', auth, orders.forUser.bind(orders, conn))
}

orders.create = function(conn, req, res, next) {
    if (!validate(req.body, 'order_create', res)) return

    var query = {
        text: [
            'SELECT create_order($1, m.market_id, $3, $4, $5) order_id',
            'FROM market m',
            'WHERE m.base_currency_id || m.quote_currency_id = $2',
        ].join('\n'),
        values: [
            req.user,
            req.body.market,
            req.body.type == 'bid' ? 0 : 1,
            req.body.price,
            req.body.amount
        ]
    }

    conn.write.query(query, function(err, dr) {
        if (err) {
            if (err.message == 'new row for relation "transaction" violates check constraint "transaction_amount_check"') {
                return res.send(400, {
                    name: 'InvalidAmount',
                    message: 'The requested transfer amount is invalid/out of range'
                })
            }

            if (err.message == 'new row for relation "account" violates check constraint "non_negative_available"') {
                return res.send(400, {
                    name: 'InsufficientFunds',
                    message: 'insufficient funds'
                })
            }

            return next(err)
        }

        var row = dr.rows[0]

        if (!row) {
            return res.send(404, { name: 'MarketNotFound', message: 'Market not found' })
        }

        activities.log(conn, req.user, 'CreateOrder', {
            market: req.body.market,
            type: req.body.type,
            price: req.body.price,
            amount: req.body.amount,
            address: req.body.address
        })

        res.send(201, { id: row.order_id })
    })
}

orders.forUser = function(conn, req, res, next) {
    Q.ninvoke(conn.read, 'query', {
        text: [
            'SELECT order_id id, base_currency_id || quote_currency_id market, side, price, volume,',
            'original - volume remaining',
            'FROM order_view o',
            'INNER JOIN market m ON m.market_id = o.market_id',
            'WHERE user_id = $1 AND volume > 0'
        ].join('\n'),
        values: [req.user]
    })
    .then(function(r) {
        res.send(r.rows.map(function(row) {
            row.type = row.type ? 'ask' : 'bid'
            row.price = req.app.cache.formatOrderPrice(row.price, row.market)
            row.amount = req.app.cache.formatOrderVolume(row.volume, row.market)
            row.remaining = req.app.cache.formatOrderVolume(row.remaining, row.market)
            return row
        }))
    }, next)
    .done()
}

orders.cancel = function(conn, req, res, next) {
    var q = 'UPDATE "order" SET cancelled = volume, volume = 0 WHERE order_id = $1 AND user_id = $2 AND volume > 0'
    Q.ninvoke(conn.write, 'query', {
        text: q,
        values: [+req.params.id, req.user]
    })
    .get('rowCount')
    .then(function(cancelled) {
        if (!cancelled) return res.send(404)
        res.send(204)
        activities.log(conn, req.user, 'CancelOrder', { id: +req.params.id })
    }, next)
    .done()
}
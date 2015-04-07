var events = require('events')
var xtend = require('xtend')
var duplexify = require('duplexify')
var union = require('sorted-union-stream')
var util = require('util')
var lexint = require('lexicographic-integer')
var collect = require('stream-collector')
var thunky = require('thunky')
var mutexify = require('mutexify')
var path = require('path')
var pump = require('pump')
var through = require('through2')
var mkdirp = require('mkdirp')
var levelup = require('levelup')
var leveldown = require('leveldown-prebuilt')
var errors = require('level-errors')
var fs = require('fs')
var encoding = require('./lib/encoding')
var indexer = require('./lib/indexer')
var messages = require('./lib/messages')
var dataset = require('./lib/dataset')

var noop = function () {}
var getLayers = function (index, key, cb) {
  var result = []

  var loop = function (key) {
    index.layers.get(key, function (err, layer) {
      if (err) return cb(err)
      index.log.get(key, function (err, keyNode) {
        if (err) return cb(err)
        index.log.get(layer, function (err, layerNode) {
          if (err) return cb(err)
          result.push([keyNode.change, layerNode.key])
          if (!layerNode.links.length) return cb(null, result) // root node
          loop(layerNode.links[0])
        })
      })
    })
  }

  loop(key)
}

var Dat = function (dir, opts) {
  if (!(this instanceof Dat)) return new Dat(dir, opts)
  if (!opts) opts = {}

  if (typeof dir === 'object' && dir) {
    opts.db = dir
    dir = null
  }

  events.EventEmitter.call(this)

  this.valueEncoding = opts.valueEncoding || opts.encoding || 'binary'
  this.head = null
  this.meta = null

  this._encoding = encoding(this.valueEncoding)
  this._layers = []
  this._layerChange = 0
  this._layerKey = null
  this._checkout = false
  this._lock = mutexify()
  this._index = null

  var self = this

  this.open = thunky(function (cb) {
    var oncheckout = function (head) {
      getLayers(self._index, head, function (err, layers) {
        if (err) return cb(err)

        self.head = head
        self._layers = layers
        self._layerChange = layers[0][0]
        self._layerKey = layers[0][1]

        cb(null, self)
      })
    }

    var onparent = function () {
      opts.parent.open(function (err) {
        if (err) return cb(err)
        self._index = opts.parent._index
        onindex()
      })
    }

    var onlayer = function (layer) {
      self._index.heads.get(layer, function (err, head) {
        if (err) return cb(err)
        oncheckout(head)
      })
    }

    var onindex = function () {
      self.meta = self._index.meta // expose

      if (opts.checkout) {
        self._checkout = true
        oncheckout(opts.checkout)
        return
      }

      if (opts.layer) {
        self._checkout = true
        onlayer(opts.layer)
        return
      }

      if (self._index.mainLayer) onlayer(self._index.mainLayer)
      else cb(null, self)
    }

    var ondb = function (db) {
      self._index = indexer(db, function (err) {
        if (err) return cb(err)
        onindex()
      })
    }

    if (opts.db) return ondb(opts.db)
    if (opts.parent) return onparent()

    if (!path) return cb(new Error('Invalid path'))

    var datPath = path.join(dir, '.dat')
    var datDb = path.join(datPath, 'db')

    fs.exists(datPath, function (exists) {
      if (exists) return ondb(levelup(datDb, {db: opts.backend || leveldown}))
      if (!opts.createIfMissing) return cb(new Error('No dat here'))

      mkdirp(datPath, function (err) {
        if (err) return cb(err)
        ondb(levelup(datDb, {db: opts.backend || leveldown}))
      })
    })
  })

  this.open(function (err) {
    if (err) return self.emit('error', err)
    self.emit('ready')
  })
}

util.inherits(Dat, events.EventEmitter)

Dat.prototype.dataset = function (name) {
  return dataset(name, this)
}

Dat.prototype.heads = function (cb) {
  if (!this._index) return this._createProxyStream(this.heads, cb)
  return collect(this._index.heads.createValueStream(), cb)
}

Dat.prototype.layers = function (cb) {
  if (!this._index) return this._createProxyStream(this.layers, cb)
  return collect(this._index.heads.createKeyStream(), cb)
}

Dat.prototype.layer = function (layer, opts) {
  return new Dat(null, xtend({parent: this, valueEncoding: this.valueEncoding, layer: layer}, opts))
}

Dat.prototype.checkout = function (head, opts) {
  return new Dat(null, xtend({parent: this, valueEncoding: this.valueEncoding, checkout: head}, opts))
}

var notFound = function (key) {
  return new errors.NotFoundError('Key not found in database [' + key + ']')
}

Dat.prototype.get = function (key, opts, cb) {
  if (typeof opts === 'function') return this.get(key, null, opts)
  if (!opts) opts = {}

  key = (opts.dataset ? opts.dataset + '!' : '!') + key

  this.open(function (err, self) {
    if (err) return cb(err)
    if (!self._layerKey) return cb(notFound(key))

    // TODO: fix rc where *latest* is updated in the middle of below block
    // which can break a checkout snapshot - workaround for now is forcing a change lookup
    if (self._checkout) return self._getChange(key, cb)

    // TODO: remove this lookup - it should be cacheable
    self._index.heads.get(self._layerKey, function (err, head) { // TODO: if the head changes once it is always changed
      if (err) return cb(err)
      if (head === self.head) return self._getLatest(key, cb)
      self._getChange(key, cb)
    })
  })
}

Dat.prototype._getLatest = function (key, cb) { // fast track
  var self = this

  this._index.data.get('!latest!' + this._layerKey + '!' + key, function (err, ptr) {
    if (err && !err.notFound) return cb(err)
    if (err) return self._getLayers(key, cb)
    self._getPointer(ptr, cb)
  })
}

var getChangePointer = function (self, key, layer, change, cb) {
  var revs = self._index.data.createValueStream({
    gt: '!changes!' + layer + '!' + key + '!',
    lte: '!changes!' + layer + '!' + key + '!' + lexint.pack(change, 'hex'),
    reverse: true,
    limit: 1
  })

  collect(revs, function (err, keys) {
    if (err) return cb(err)
    cb(null, keys.length ? keys[0] : null)
  })
}

Dat.prototype._getChange = function (key, cb) { // slow track
  var self = this
  getChangePointer(this, key, this._layerKey, this._layerChange, function (err, ptr) {
    if (err) return cb(err)
    if (!ptr) return self._getLayers(key, cb)
    self._getPointer(ptr, cb)
  })
}

Dat.prototype._getLayers = function (key, cb) {
  var i = 0
  var self = this

  var loop = function (err, ptr) {
    if (err) return cb(err)
    if (ptr) return self._getPointer(ptr, cb)
    if (++i >= self._layers.length) return cb(notFound(key))
    getChangePointer(self, key, self._layers[i][1], self._layers[i][0], loop)
  }

  loop(null, null)
}

Dat.prototype._getPointer = function (ptr, cb) {
  var i = ptr.lastIndexOf('!')
  var index = parseInt(ptr.slice(i + 1), 10)
  var self = this

  this._index.get(ptr.slice(0, i), function (err, node, commit) {
    if (err) return cb(err)
    var entry = commit.operations[index]
    if (entry.type === messages.TYPE.DELETE) return cb(notFound(entry.key))
    cb(null, self._encoding.decode(entry.value))
  })
}

Dat.prototype.put = function (key, value, opts, cb) {
  if (typeof opts === 'function') return this.put(key, value, null, opts)
  if (!opts) opts = {}
  this._commit([{type: messages.TYPE.PUT, dataset: opts.dataset, key: key, value: this._encoding.encode(value)}], cb)
}

Dat.prototype.del = function (key, opts, cb) {
  if (typeof opts === 'function') return this.del(key, null, opts)
  if (!opts) opts = {}
  this._commit([{type: messages.TYPE.DELETE, dataset: opts.dataset, key: key}], cb)
}

Dat.prototype.batch = function (batch, opts, cb) {
  if (typeof opts === 'function') return this.batch(batch, null, opts)
  if (!opts) opts = {}

  var operations = new Array(batch.length)
  for (var i = 0; i < batch.length; i++) {
    operations[i] = {
      type: batch[i].type === 'del' ? messages.TYPE.DELETE : messages.TYPE.PUT,
      dataset: opts.dataset,
      key: batch[i].key,
      value: this._encoding.encode(batch[i].value)
    }
  }
  this._commit(operations, cb)
}

Dat.prototype._commit = function (operations, cb) {
  if (!cb) cb = noop
  this.open(function (err, self) {
    if (err) return cb(err)
    self._lock(function (release) {
      self._index.add(self.head && [self.head], {operations: operations}, function (err, node, layer) {
        if (err) return release(cb, err)

        if (!self._layerKey || self._layerKey !== layer) {
          self._layers.unshift([node.change, layer])
          self._layerKey = layer
        }

        self._layerChange = self._layers[0][0] = node.change
        self.head = node.key

        release(cb)
      })
    })
  })
}

Dat.prototype.flush = function (cb) {
  this.open(function (err, self) {
    if (err) return cb(err)
    self._index.flush(function (err) {
      cb(err)
    })
  })
}

Dat.prototype.changes =
Dat.prototype.createChangesStream = function (opts) {
  if (!this._index) return this._createProxyStream(this.createChangesStream, opts)
  return this._index.log.createReadStream(opts)
}

Dat.prototype.createWriteStream = function (opts) {
  if (!this._index) return this._createProxyStream(this.createWriteStream, opts)
  var self = this
  return through.obj(function (data, enc, cb) {
    self._commit([{
      type: data.type === 'del' ? messages.TYPE.DELETE : messages.TYPE.PUT,
      dataset: opts.dataset,
      key: data.key,
      value: this._encoding.encode(data.value)
    }], function (err) {
      cb(err)
    })
  })
}

Dat.prototype.createKeyStream = function (opts) {
  if (!opts) opts = {}
  opts.keys = true
  opts.values = false
  return this.createReadStream(opts)
}

Dat.prototype.createValueStream = function (opts) {
  if (!opts) opts = {}
  opts.keys = false
  opts.values = true
  return this.createReadStream(opts)
}

var toKey = function (data) {
  return data.key.slice(data.key.lastIndexOf('!') + 1)
}

var emptyStream = function () {
  var stream = through.obj()
  stream.end()
  return stream
}

Dat.prototype.createReadStream = function (opts) {
  if (!this._index) return this._createProxyStream(this.createReadStream, opts)
  if (!opts) opts = {}

  var self = this
  var justKeys = opts.keys && !opts.values
  var justValues = opts.values && !opts.keys

  if (!this._layers.length) return emptyStream()

  var stream = this._layers
    .map(function (layer) {
      var prefix = '!latest!' + layer[1] + '!' + (opts.dataset || '') + '!'
      var rs = self._index.data.createReadStream({
        gt: prefix + (opts.gt || ''),
        lt: prefix + (opts.lt || '\xff'),
        lte: opts.lte ? prefix + opts.lte : undefined,
        gte: opts.gte ? prefix + opts.gte : undefined
      })

      return rs
    })
    .reduce(function (a, b) {
      return union(a, b, toKey)
    })

  var write = function (data, enc, cb) {
    var key = data.key.slice(data.key.lastIndexOf('!') + 1)

    self.get(key, opts, function (err, value) {
      if (err && err.notFound) return cb()
      if (err) return cb(err)
      if (justKeys) return cb(null, key)
      if (justValues) return cb(null, value)
      cb(null, {key: key, value: value})
    })
  }

  return pump(stream, through.obj(write))
}

Dat.prototype.createReplicationStream =
Dat.prototype.replicate = function (opts) {
  if (!this._index) return this._createProxyStream(this.replicate, opts)

  var self = this
  var finalize = function (cb) {
    self.flush(cb)
  }

  return this._index.log.replicate(xtend(opts, {finalize: finalize}))
}

Dat.prototype.createPullStream =
Dat.prototype.pull = function (opts) {
  if (!opts) opts = {}
  opts.mode = 'pull'
  return this.replicate(opts)
}

Dat.prototype.createPushStream =
Dat.prototype.push = function (opts) {
  if (!opts) opts = {}
  opts.mode = 'push'
  return this.replicate(opts)
}

Dat.prototype._createProxyStream = function (method, opts) {
  var proxy = duplexify.obj()

  this.open(function (err, self) {
    if (err) return proxy.destroy(err)
    if (proxy.destroyed) return proxy.destroy()

    var stream = method.call(self, opts)

    stream.on('pull', function (value) {
      proxy.emit('pull', value)
    })

    stream.on('push', function (value) {
      proxy.emit('push', value)
    })

    stream.on('metadata', function (value) {
      proxy.emit('metadata', value)
    })

    proxy.setReadable(!!stream.readable && stream)
    proxy.setWritable(!!stream.writable && stream)
  })

  return proxy
}

module.exports = Dat

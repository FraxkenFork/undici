'use strict'

const { kProxy, kClose, kDestroy, kDispatch, kConnector } = require('../core/symbols')
const { URL } = require('node:url')
const Agent = require('./agent')
const Pool = require('./pool')
const DispatcherBase = require('./dispatcher-base')
const { InvalidArgumentError, RequestAbortedError, SecureProxyConnectionError } = require('../core/errors')
const buildConnector = require('../core/connect')
const Client = require('./client')

const kAgent = Symbol('proxy agent')
const kClient = Symbol('proxy client')
const kProxyHeaders = Symbol('proxy headers')
const kRequestTls = Symbol('request tls settings')
const kProxyTls = Symbol('proxy tls settings')
const kConnectEndpoint = Symbol('connect endpoint function')
const kTunnelProxy = Symbol('tunnel proxy')

function defaultProtocolPort (protocol) {
  return protocol === 'https:' ? 443 : 80
}

function defaultFactory (origin, opts) {
  return new Pool(origin, opts)
}

const noop = () => {}

class ProxyClient extends DispatcherBase {
  #client = null
  constructor (origin, opts) {
    if (typeof origin === 'string') {
      origin = new URL(origin)
    }

    if (origin.protocol !== 'http:' && origin.protocol !== 'https:') {
      throw new InvalidArgumentError('ProxyClient only supports http and https protocols')
    }

    super()

    this.#client = new Client(origin, opts)
  }

  async [kClose] () {
    await this.#client.close()
  }

  async [kDestroy] () {
    await this.#client.destroy()
  }

  async [kDispatch] (opts, handler) {
    const { method, origin } = opts
    if (method === 'CONNECT') {
      this.#client[kConnector]({
        origin,
        port: opts.port || defaultProtocolPort(opts.protocol),
        path: opts.host,
        signal: opts.signal,
        headers: {
          ...this[kProxyHeaders],
          host: opts.host
        },
        servername: this[kProxyTls]?.servername || opts.servername
      },
      (err, socket) => {
        if (err) {
          handler.callback(err)
        } else {
          handler.callback(null, { socket, statusCode: 200 })
        }
      }
      )
      return
    }
    if (typeof origin === 'string') {
      opts.origin = new URL(origin)
    }

    return this.#client.dispatch(opts, handler)
  }
}
class ProxyAgent extends DispatcherBase {
  constructor (opts) {
    if (!opts || (typeof opts === 'object' && !(opts instanceof URL) && !opts.uri)) {
      throw new InvalidArgumentError('Proxy uri is mandatory')
    }

    const { clientFactory = defaultFactory } = opts
    if (typeof clientFactory !== 'function') {
      throw new InvalidArgumentError('Proxy opts.clientFactory must be a function.')
    }

    const { proxyTunnel = true } = opts

    super()

    const url = this.#getUrl(opts)
    const { href, origin, port, protocol, username, password, hostname: proxyHostname } = url

    this[kProxy] = { uri: href, protocol }
    this[kRequestTls] = opts.requestTls
    this[kProxyTls] = opts.proxyTls
    this[kProxyHeaders] = opts.headers || {}

    if (opts.auth && opts.token) {
      throw new InvalidArgumentError('opts.auth cannot be used in combination with opts.token')
    } else if (opts.auth) {
      /* @deprecated in favour of opts.token */
      this[kProxyHeaders]['proxy-authorization'] = `Basic ${opts.auth}`
    } else if (opts.token) {
      this[kProxyHeaders]['proxy-authorization'] = opts.token
    } else if (username && password) {
      this[kProxyHeaders]['proxy-authorization'] = `Basic ${Buffer.from(`${decodeURIComponent(username)}:${decodeURIComponent(password)}`).toString('base64')}`
    }

    const factory = (!proxyTunnel && protocol === 'http:')
      ? (origin, options) => {
          if (origin.protocol === 'http:') {
            return new ProxyClient(origin, options)
          }
          return new Client(origin, options)
        }
      : undefined

    const connect = buildConnector({ ...opts.proxyTls })
    this[kConnectEndpoint] = buildConnector({ ...opts.requestTls })
    this[kClient] = clientFactory(url, { connect, factory })
    this[kTunnelProxy] = proxyTunnel
    this[kAgent] = new Agent({
      ...opts,
      connect: async (opts, callback) => {
        let requestedPath = opts.host
        if (!opts.port) {
          requestedPath += `:${defaultProtocolPort(opts.protocol)}`
        }
        try {
          const { socket, statusCode } = await this[kClient].connect({
            origin,
            port,
            path: requestedPath,
            signal: opts.signal,
            headers: {
              ...this[kProxyHeaders],
              host: opts.host,
              ...(opts.connections == null || opts.connections > 0 ? { 'proxy-connection': 'keep-alive' } : {})
            },
            servername: this[kProxyTls]?.servername || proxyHostname
          })
          if (statusCode !== 200) {
            socket.on('error', noop).destroy()
            callback(new RequestAbortedError(`Proxy response (${statusCode}) !== 200 when HTTP Tunneling`))
          }
          if (opts.protocol !== 'https:') {
            callback(null, socket)
            return
          }
          let servername
          if (this[kRequestTls]) {
            servername = this[kRequestTls].servername
          } else {
            servername = opts.servername
          }
          this[kConnectEndpoint]({ ...opts, servername, httpSocket: socket }, callback)
        } catch (err) {
          if (err.code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
            // Throw a custom error to avoid loop in client.js#connect
            callback(new SecureProxyConnectionError(err))
          } else {
            callback(err)
          }
        }
      }
    })
  }

  dispatch (opts, handler) {
    const headers = buildHeaders(opts.headers)
    throwIfProxyAuthIsSent(headers)

    if (headers && !('host' in headers) && !('Host' in headers)) {
      const { host } = new URL(opts.origin)
      headers.host = host
    }

    if (!this.#shouldConnect(new URL(opts.origin))) {
      opts.path = opts.origin + opts.path
    }

    return this[kAgent].dispatch(
      {
        ...opts,
        headers
      },
      handler
    )
  }

  /**
   * @param {import('../types/proxy-agent').ProxyAgent.Options | string | URL} opts
   * @returns {URL}
   */
  #getUrl (opts) {
    if (typeof opts === 'string') {
      return new URL(opts)
    } else if (opts instanceof URL) {
      return opts
    } else {
      return new URL(opts.uri)
    }
  }

  async [kClose] () {
    await this[kAgent].close()
    await this[kClient].close()
  }

  async [kDestroy] () {
    await this[kAgent].destroy()
    await this[kClient].destroy()
  }

  #shouldConnect (uri) {
    if (typeof uri === 'string') {
      uri = new URL(uri)
    }
    if (this[kTunnelProxy]) {
      return true
    }
    if (uri.protocol !== 'http:' || this[kProxy].protocol !== 'http:') {
      return true
    }
    return false
  }
}

/**
 * @param {string[] | Record<string, string>} headers
 * @returns {Record<string, string>}
 */
function buildHeaders (headers) {
  // When using undici.fetch, the headers list is stored
  // as an array.
  if (Array.isArray(headers)) {
    /** @type {Record<string, string>} */
    const headersPair = {}

    for (let i = 0; i < headers.length; i += 2) {
      headersPair[headers[i]] = headers[i + 1]
    }

    return headersPair
  }

  return headers
}

/**
 * @param {Record<string, string>} headers
 *
 * Previous versions of ProxyAgent suggests the Proxy-Authorization in request headers
 * Nevertheless, it was changed and to avoid a security vulnerability by end users
 * this check was created.
 * It should be removed in the next major version for performance reasons
 */
function throwIfProxyAuthIsSent (headers) {
  const existProxyAuth = headers && Object.keys(headers)
    .find((key) => key.toLowerCase() === 'proxy-authorization')
  if (existProxyAuth) {
    throw new InvalidArgumentError('Proxy-Authorization should be sent in ProxyAgent constructor')
  }
}

module.exports = ProxyAgent

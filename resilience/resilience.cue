// What bounds every hop of a request and what sheds load at the door: the
// numbers the schema's roles, the Caddyfile and the Kubernetes release are
// emitted with, each constrained against the hop it wraps. Timeouts nest, so
// the innermost fails first and every caller still has time to answer; a set
// that does not nest does not evaluate, and nothing is emitted from it.
//
// Two kinds of bound sit in one chain. Caddy's (door) stop at an upstream's
// response headers, and the reads between them are bounded apart; Dapr's
// (mesh) and the gateway's run until the response is complete, body
// included, so an answer streamed past them is cut.
package resilience

import "strings"

#Resilience: {
	// Seconds.
	timeouts: {
		// What Postgres bounds per token role: clients, and the service role
		// pipelines and the ticker write as.
		statement: {client: int & >0, service: int & >client}
		lock: {client: int & <statement.client, service: int & <statement.service}
		idleInTransaction: {client: int & >statement.client, service: int & >statement.service}

		// Electric answers a live request it has nothing for after this hold
		// (its default; nothing sets it).
		electricHold: int & >0

		// Sidecar to app (Dapr Resiliency), whole response: a page renders
		// through render, whose door reaches crud back through caddy.
		mesh: {
			crud:     int & >statement.service
			caddy:    int & >door.crud
			render:   int & >caddy
			auth:     int & >statement.client
			electric: int & >electricHold
		}

		// Caddy to its upstreams, to their response headers: the door is
		// caddy, the outermost hop under compose and the one inside the
		// gateway on Kubernetes. The ticker's poke outlasts one of its calls to
		// crud; a sweep of several may outlast it, and the poke after it sweeps the
		// same keys again (services/ticker), so a door that gave up costs a repeat.
		door: {
			crud:     int & >mesh.crud
			render:   int & >mesh.render
			auth:     int & >mesh.auth
			electric: int & >mesh.electric
			ticker:   int & >tickerCall
			blobs:    int & >0
		}
		// Each read render makes through its door: past caddy's sidecar on
		// Kubernetes and caddy's crud bound under compose, inside render's
		// own. One read each; a page of several sequential reads can outlast
		// the render bounds outside it.
		renderDoor: int & >mesh.caddy & <mesh.render

		// A drain's call to crud from the transform, which reaches PostgREST
		// direct: the service role's statement bound ends a slow call first.
		// A function's own SET statement_timeout arms nothing for the call
		// that enters it; the role's is the one that holds.
		drain: int & >statement.service
		// Each call the ticker makes to crud, direct, as the service role: one
		// it gave up on would commit anyway and be made again by the next tick.
		tickerCall: int & >statement.service

		// Caddy's connect to any upstream, and the longest silence it allows
		// between reads of Electric's stream: compose's bound, as on
		// Kubernetes the mesh's and the gateway's end a stream first.
		dial:       int & >0
		streamRead: int & >door.electric

		// The gateway's whole request, by path prefix (HTTPRoute timeouts).
		// Electric's gate runs before Electric itself, on the same request.
		gateway: {
			default:  int & >door.render & >door.crud & >door.auth & >door.blobs & >door.ticker
			electric: int & >(door.auth + door.electric)
		}
	}

	// Envoy's concurrency limits on caddy's connection pool, one pool per
	// route rule (`/` and `/electric/`): past them the gateway answers 503 at
	// once rather than queue. An Electric live read holds a request for its
	// hold, one per shape a tab syncs.
	gateway: {
		maxConnections:      int & >0
		maxParallelRequests: int & >0
		maxPendingRequests:  int & >0 & <=maxParallelRequests
	}
}

resilience: #Resilience & {
	timeouts: {
		statement: {client: 5, service: 30}
		lock: {client: 2, service: 5}
		idleInTransaction: {client: 10, service: 60}
		electricHold: 20
		mesh: {crud: 35, caddy: 40, render: 42, auth: 10, electric: 60}
		door: {crud: 38, render: 44, auth: 12, electric: 70, ticker: 40, blobs: 40}
		renderDoor: 41
		drain:      35
		tickerCall: 35
		dial:       2
		streamRead: 300
		gateway: {default: 45, electric: 90}
	}
	gateway: {maxConnections: 1024, maxParallelRequests: 1024, maxPendingRequests: 128}
}

// Caddy's bound on each upstream, `import bounded-<hop>` in the Caddyfile:
// emitted ahead of it, so the Caddyfile names hops and never a number.
caddySnippets: strings.Join([for hop, s in resilience.timeouts.door {
	"""
	(bounded-\(hop)) {
	  transport http {
	    dial_timeout \(resilience.timeouts.dial)s
	    response_header_timeout \(s)s
	\([if hop == "electric" {"    read_timeout \(resilience.timeouts.streamRead)s\n"}, ""][0])  }
	}

	"""
}], "")

package observability

import "encoding/yaml"

// Observability manifests for Option B: VictoriaMetrics + Jaeger + Vector
#ObservabilityStack: {
	namespace:        string | *"observability"
	gatewayClassName: string | *"eg"
	domainSuffix:     string

	let ns = namespace
	let host = "telemetry.\(domainSuffix)"
	let gatewayClass = gatewayClassName
	let appLabels = {
		"app.kubernetes.io/part-of":   "pronto-observability"
		"app.kubernetes.io/managed-by": "cue"
	}

	let namespaceObj = [{
		apiVersion: "v1"
		kind:       "Namespace"
		metadata: {
			name:   ns
			labels: appLabels
		}
	}]

	let vmScrapeConfigObj = [{
		apiVersion: "v1"
		kind:       "ConfigMap"
		metadata: {
			name:      "vmsingle-config"
			namespace: ns
			labels:    appLabels
		}
		data: "promscrape.yaml": """
			global:
			  scrape_interval: 10s
			scrape_configs:
			  - job_name: 'kubernetes-pods'
			    kubernetes_sd_configs:
			      - role: pod
			    relabel_configs:
			      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
			        action: keep
			        regex: true
			      # Pod discovery yields a target per container port: the annotated one.
			      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_port, __meta_kubernetes_pod_container_port_number]
			        action: keep_if_equal
			      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_path]
			        action: replace
			        target_label: __metrics_path__
			        regex: (.+)
			      - source_labels: [__address__, __meta_kubernetes_pod_annotation_prometheus_io_port]
			        action: replace
			        regex: ([^:]+)(?::\\d+)?;(\\d+)
			        replacement: $1:$2
			        target_label: __address__
			      - action: labelmap
			        regex: __meta_kubernetes_pod_label_(.+)
			  - job_name: 'postgrest'
			    kubernetes_sd_configs:
			      - role: pod
			    relabel_configs:
			      - source_labels: [__meta_kubernetes_pod_label_app_kubernetes_io_component]
			        action: keep
			        regex: crud
			      - source_labels: [__meta_kubernetes_pod_container_port_name]
			        action: keep
			        regex: admin
			      - target_label: __metrics_path__
			        replacement: /metrics
			  - job_name: 'cnpg-database'
			    kubernetes_sd_configs:
			      - role: pod
			    relabel_configs:
			      - source_labels: [__meta_kubernetes_pod_label_cnpg_io_cluster]
			        action: keep
			        regex: .+
			      - source_labels: [__meta_kubernetes_pod_container_port_name]
			        action: keep
			        regex: metrics
			      - target_label: __metrics_path__
			        replacement: /metrics
			  - job_name: 'dapr'
			    kubernetes_sd_configs:
			      - role: pod
			    relabel_configs:
			      - source_labels: [__meta_kubernetes_pod_annotation_dapr_io_enabled]
			        action: keep
			        regex: true
			      # Pod discovery yields a target per container port: daprd's metrics one.
			      - source_labels: [__meta_kubernetes_pod_container_port_name]
			        action: keep
			        regex: dapr-metrics
			      - source_labels: [__address__]
			        action: replace
			        regex: ([^:]+)(?::\\d+)?
			        replacement: $1:9090
			        target_label: __address__
			      - target_label: __metrics_path__
			        replacement: /
			"""
	}]

	// Pod discovery (kubernetes_sd_configs) reads the API server as vmsingle.
	let vmRbacObj = [
		{
			apiVersion: "v1"
			kind:       "ServiceAccount"
			metadata: {name: "vmsingle", namespace: ns, labels: appLabels}
		},
		{
			apiVersion: "rbac.authorization.k8s.io/v1"
			kind:       "ClusterRole"
			metadata: {name: "pronto-vmsingle", labels: appLabels}
			rules: [{apiGroups: [""], resources: ["pods"], verbs: ["get", "list", "watch"]}]
		},
		{
			apiVersion: "rbac.authorization.k8s.io/v1"
			kind:       "ClusterRoleBinding"
			metadata: {name: "pronto-vmsingle", labels: appLabels}
			roleRef: {apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: "pronto-vmsingle"}
			subjects: [{kind: "ServiceAccount", name: "vmsingle", namespace: ns}]
		},
	]

	let vmDeploymentObj = [{
		apiVersion: "apps/v1"
		kind:       "Deployment"
		metadata: {
			name:      "vmsingle"
			namespace: ns
			labels:    appLabels & {"app.kubernetes.io/name": "vmsingle"}
		}
		spec: {
			replicas: 1
			selector: matchLabels: {"app.kubernetes.io/name": "vmsingle"}
			template: {
				metadata: labels: appLabels & {"app.kubernetes.io/name": "vmsingle"}
				spec: {
					serviceAccountName: "vmsingle"
					containers: [{
						name:  "vmsingle"
						image: "docker.io/victoriametrics/victoria-metrics:v1.106.1@sha256:54b283129634239db62798fd8d92e8d8d4372a0b114e72967eb233dbb264ff53"
						args: [
							"-promscrape.config=/etc/vmsingle/promscrape.yaml",
							"-storageDataPath=/vmsingle-data",
							"-httpListenAddr=:8428",
						]
						ports: [{name: "http", containerPort: 8428}]
						volumeMounts: [{
							name:      "config"
							mountPath: "/etc/vmsingle"
						}]
						resources: {
							requests: {cpu: "20m", memory: "50Mi"}
							limits: {cpu: "200m", memory: "250Mi"}
						}
					}]
					volumes: [{
						name: "config"
						configMap: name: "vmsingle-config"
					}]
				}
			}
		}
	}]

	let vmServiceObj = [{
		apiVersion: "v1"
		kind:       "Service"
		metadata: {
			name:      "vmsingle"
			namespace: ns
			labels:    appLabels & {"app.kubernetes.io/name": "vmsingle"}
		}
		spec: {
			type: "ClusterIP"
			selector: {"app.kubernetes.io/name": "vmsingle"}
			ports: [{name: "http", port: 8428, targetPort: 8428}]
		}
	}]

	let jaegerDeploymentObj = [{
		apiVersion: "apps/v1"
		kind:       "Deployment"
		metadata: {
			name:      "jaeger"
			namespace: ns
			labels:    appLabels & {"app.kubernetes.io/name": "jaeger"}
		}
		spec: {
			replicas: 1
			selector: matchLabels: {"app.kubernetes.io/name": "jaeger"}
			template: {
				metadata: labels: appLabels & {"app.kubernetes.io/name": "jaeger"}
				spec: {
					containers: [{
						name:  "jaeger"
						image: "docker.io/jaegertracing/all-in-one:1.64.0@sha256:7e9591218e7ddd51e568ef892e3ea190ae420ecf97c4d718910a3f57e076c216"
						env: [
							{name: "COLLECTOR_ZIPKIN_HOST_PORT", value: ":9411"},
							{name: "COLLECTOR_OTLP_ENABLED", value: "true"},
							{name: "QUERY_BASE_PATH", value: "/jaeger"},
						]
						ports: [
							{name: "ui", containerPort: 16686},
							{name: "otlp-grpc", containerPort: 4317},
							{name: "otlp-http", containerPort: 4318},
							{name: "zipkin", containerPort: 9411},
						]
						resources: {
							requests: {cpu: "20m", memory: "60Mi"}
							limits: {cpu: "200m", memory: "250Mi"}
						}
					}]
				}
			}
		}
	}]

	let jaegerServiceObj = [{
		apiVersion: "v1"
		kind:       "Service"
		metadata: {
			name:      "jaeger"
			namespace: ns
			labels:    appLabels & {"app.kubernetes.io/name": "jaeger"}
		}
		spec: {
			type: "ClusterIP"
			selector: {"app.kubernetes.io/name": "jaeger"}
			ports: [
				{name: "ui", port: 16686, targetPort: 16686},
				{name: "otlp-grpc", port: 4317, targetPort: 4317},
				{name: "otlp-http", port: 4318, targetPort: 4318},
				{name: "zipkin", port: 9411, targetPort: 9411},
			]
		}
	}]

	let vectorConfigObj = [{
		apiVersion: "v1"
		kind:       "ConfigMap"
		metadata: {
			name:      "vector-config"
			namespace: ns
			labels:    appLabels
		}
		data: "vector.yaml": """
			sources:
			  internal_metrics:
			    type: internal_metrics
			sinks:
			  stdout:
			    type: console
			    inputs: [internal_metrics]
			    encoding:
			      codec: json
			"""
	}]

	let vectorDeploymentObj = [{
		apiVersion: "apps/v1"
		kind:       "Deployment"
		metadata: {
			name:      "vector"
			namespace: ns
			labels:    appLabels & {"app.kubernetes.io/name": "vector"}
		}
		spec: {
			replicas: 1
			selector: matchLabels: {"app.kubernetes.io/name": "vector"}
			template: {
				metadata: labels: appLabels & {"app.kubernetes.io/name": "vector"}
				spec: {
					containers: [{
						name:  "vector"
						image: "docker.io/timberio/vector:0.43.0-alpine@sha256:7bcb75f71f93d312d928182e6a07f6df14a18d030785bb3197ac01128bd287a3"
						args: ["--config", "/etc/vector/vector.yaml"]
						volumeMounts: [{
							name:      "config"
							mountPath: "/etc/vector"
						}]
						resources: {
							requests: {cpu: "10m", memory: "25Mi"}
							limits: {cpu: "100m", memory: "100Mi"}
						}
					}]
					volumes: [{
						name: "config"
						configMap: name: "vector-config"
					}]
				}
			}
		}
	}]

	// Its own gateway, merged by Envoy Gateway with each app's on the shared
	// proxy; a listener scoped to its hostname keeps the ports from conflicting.
	let telemetryGatewayObj = [{
		apiVersion: "gateway.networking.k8s.io/v1"
		kind:       "Gateway"
		metadata: {
			name:      "telemetry"
			namespace: ns
			labels:    appLabels
		}
		spec: {
			gatewayClassName: gatewayClass
			listeners: [{
				name:     "http"
				protocol: "HTTP"
				port:     80
				hostname: host
				allowedRoutes: namespaces: from: "Same"
			}]
		}
	}]

	let telemetryRoutesObj = [{
		apiVersion: "gateway.networking.k8s.io/v1"
		kind:       "HTTPRoute"
		metadata: {
			name:      "telemetry-route"
			namespace: ns
			labels:    appLabels
		}
		spec: {
			parentRefs: [{name: "telemetry"}]
			hostnames: [host]
			rules: [
				{
					matches: [{
						path: {
							type:  "PathPrefix"
							value: "/vmui"
						}
					}]
					backendRefs: [{
						name: "vmsingle"
						port: 8428
					}]
				},
				{
					matches: [{
						path: {
							type:  "PathPrefix"
							value: "/jaeger"
						}
					}]
					backendRefs: [{
						name: "jaeger"
						port: 16686
					}]
				},
			]
		}
	}]

	let observabilityNetworkPolicyObj = [{
		apiVersion: "networking.k8s.io/v1"
		kind:       "NetworkPolicy"
		metadata: {
			name:      "observability-netpol"
			namespace: ns
			labels:    appLabels
		}
		spec: {
			podSelector: {}
			policyTypes: ["Ingress", "Egress"]
			ingress: [
				{
					ports: [
						{port: 8428, protocol: "TCP"},
						{port: 16686, protocol: "TCP"},
						{port: 4317, protocol: "TCP"},
						{port: 4318, protocol: "TCP"},
						{port: 9411, protocol: "TCP"},
					]
				},
			]
			egress: [
				{
					ports: [
						{port: 53, protocol: "UDP"},
						{port: 53, protocol: "TCP"},
					]
				},
				// Scrape targets: PostgREST's admin port, CloudNativePG's exporter,
				// caddy, daprd's metrics.
				{
					ports: [
						{port: 3001, protocol: "TCP"},
						{port: 9187, protocol: "TCP"},
						{port: 8080, protocol: "TCP"},
						{port: 9090, protocol: "TCP"},
					]
				},
				// Pod discovery through the API server.
				{
					ports: [
						{port: 443, protocol: "TCP"},
						{port: 6443, protocol: "TCP"},
					]
				},
			]
		}
	}]

	objects: [
		for list in [
			namespaceObj,
			vmScrapeConfigObj,
			vmRbacObj,
			vmDeploymentObj,
			vmServiceObj,
			jaegerDeploymentObj,
			jaegerServiceObj,
			vectorConfigObj,
			vectorDeploymentObj,
			telemetryGatewayObj,
			telemetryRoutesObj,
			observabilityNetworkPolicyObj,
		]
		for item in list {item},
	]

	manifests: yaml.MarshalStream(objects)
}

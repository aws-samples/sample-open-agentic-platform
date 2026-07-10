// aws-service-identity TraitDefinition
//
// Grants a workload an AWS IAM identity via EKS Pod Identity — secretlessly and
// with zero cluster parameters. Emits a platform.gitops.io/PodIdentity claim
// (XPodIdentity Composition), which resolves clusterName/region ambiently from
// the cluster's env-config EnvironmentConfig and creates the IAM Role
// (name "<serviceAccount>-role") + PodIdentityAssociation bound to the
// workload's ServiceAccount (owned by the component, name == context.name).
//
// Ordering: EKS injects Pod Identity creds via a mutating webhook at pod
// admission, which only fires if the association already exists. To avoid that
// race we SELF-INJECT the creds URI + the pods.eks.amazonaws.com projected
// token and add an init container that blocks until `aws sts get-caller-identity`
// succeeds. Verified: the EKS webhook skips injection when the creds URI env is
// already present (no duplicate volume), and STS resolves without a region env.
//
// Cloud-agnostic sibling pattern: gcp-service-identity / azure-service-identity.
"aws-service-identity": {
	alias:       ""
	annotations: {}
	attributes: {
		appliesToWorkloads: ["deployments.apps", "rollouts.argoproj.io"]
		conflictsWith: []
		podDisruptive:   true
		workloadRefPath: ""
	}
	description: "Grant a workload an AWS IAM identity via EKS Pod Identity (secretless, no cluster params)"
	labels: {}
	type: "trait"
}

template: {
	parameter: {
		// +usage=Sibling component names whose IAM policies to attach to this workload's role
		accessFor?: [...string]
		// +usage=Container to inject AWS credentials into (defaults to the component name)
		containerName: *context.name | string
		// +usage=Image for the init container that waits for AWS identity readiness
		waitImage: *"public.ecr.aws/aws-cli/aws-cli:latest" | string
	}

	// Self-injected creds URI + token mount (the EKS webhook skips injection when
	// AWS_CONTAINER_CREDENTIALS_FULL_URI is already present). No region needed —
	// STS resolves without it, and apps set their own region via env if required.
	_credsEnv: [
		{name: "AWS_CONTAINER_CREDENTIALS_FULL_URI", value: "http://169.254.170.23/v1/credentials"},
		{name: "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE", value: "/var/run/secrets/pods.eks.amazonaws.com/serviceaccount/eks-pod-identity-token"},
	]
	_tokenMount: {
		name:      "eks-pod-identity-token"
		mountPath: "/var/run/secrets/pods.eks.amazonaws.com/serviceaccount"
		readOnly:  true
	}

	outputs: {
		// XPodIdentity claim — the Composition resolves clusterName/region from
		// env-config and creates the IAM Role + PodIdentityAssociation.
		"\(context.name)-identity": {
			apiVersion: "platform.gitops.io/v1alpha1"
			kind:       "PodIdentity"
			metadata: {
				name:      context.name
				namespace: context.namespace
			}
			spec: {
				serviceAccount: context.name
				namespace:      context.namespace
			}
		}

		// Attach sibling components' IAM policies to the role the Composition
		// creates (deterministic name "<serviceAccount>-role").
		if parameter.accessFor != _|_ {
			for _, c in parameter.accessFor {
				"\(context.name)-\(c)-iam-policy": {
					apiVersion: "iam.aws.upbound.io/v1beta1"
					kind:       "RolePolicyAttachment"
					metadata: name: "\(context.name)-\(c)-role-policy-attachment"
					spec: {
						forProvider: {
							policyArnRef: name: "\(context.appName)-\(c)-iam-policy"
							role: "\(context.name)-role"
						}
						providerConfigRef: name: "provider-aws-config"
					}
				}
			}
		}
	}

	// Patch the workload pod: token volume, init-wait container, creds env on the
	// app container.
	patch: spec: template: spec: {
		// +patchKey=name
		volumes: [{
			name: "eks-pod-identity-token"
			projected: sources: [{
				serviceAccountToken: {
					audience:          "pods.eks.amazonaws.com"
					expirationSeconds: 86400
					path:              "eks-pod-identity-token"
				}
			}]
		}]
		// +patchKey=name
		initContainers: [{
			name:    "wait-for-aws-identity"
			image:   parameter.waitImage
			command: ["sh", "-c", "until aws sts get-caller-identity >/dev/null 2>&1; do echo 'waiting for AWS pod identity...'; sleep 2; done; echo 'AWS identity ready'"]
			env:         _credsEnv
			volumeMounts: [_tokenMount]
		}]
		// +patchKey=name
		containers: [{
			name: parameter.containerName
			// +patchKey=name
			env: _credsEnv
			// +patchKey=name
			volumeMounts: [_tokenMount]
		}]
	}
}

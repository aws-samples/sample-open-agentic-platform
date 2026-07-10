#!/usr/bin/env bash
# Generate KubeVela YAML ComponentDefinitions from CUE source files.
# Usage: ./generate.sh
# Requires: vela CLI (https://kubevela.io/docs/installation/kubernetes/#install-vela-cli)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPONENTS_DIR="${SCRIPT_DIR}/definitions/components"
TRAITS_DIR="${SCRIPT_DIR}/definitions/traits"
YAML_DIR="${SCRIPT_DIR}/../../gitops/addons/charts/oam-agent-components/templates"

if ! command -v vela &>/dev/null; then
  echo "Error: vela CLI not found" >&2
  exit 1
fi

echo "Rendering CUE definitions → YAML"
echo "  Components: ${COMPONENTS_DIR}"
echo "  Traits:     ${TRAITS_DIR}"
echo "  Output:     ${YAML_DIR}"

vela def render "${COMPONENTS_DIR}" -o "${YAML_DIR}" \
  --message "# Code generated from CUE definitions. DO NOT EDIT."

if [ -d "${TRAITS_DIR}" ]; then
  vela def render "${TRAITS_DIR}" -o "${YAML_DIR}" \
    --message "# Code generated from CUE definitions. DO NOT EDIT."
fi

echo "Done. Generated files:"
ls -1 "${YAML_DIR}"/*.yaml

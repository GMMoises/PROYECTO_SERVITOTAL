#!/bin/sh
set -eu
if [ "${MIGRAR_AL_INICIAR:-true}" = "true" ]; then
  node /app/servidor/dist/infraestructura/migraciones/cli.js aplicar
fi
exec "$@"

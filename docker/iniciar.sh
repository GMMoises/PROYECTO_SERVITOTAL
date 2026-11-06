#!/bin/sh
set -eu
if [ "${MIGRAR_AL_INICIAR:-true}" = "true" ]; then
  node /app/servidor/dist/infraestructura/migraciones/cli.js aplicar
fi
node /app/servidor/dist/infraestructura/administrador-inicial.js
unset ADMIN_INICIAL_PASSWORD ADMIN_INICIAL_USUARIO
exec "$@"

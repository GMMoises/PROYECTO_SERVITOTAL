# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY compartido/package.json compartido/package.json
COPY servidor/package.json servidor/package.json
COPY panel/package.json panel/package.json
# El prepare de compartido necesita sus fuentes: se compila explicitamente despues.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY compartido/ compartido/
COPY servidor/ servidor/
COPY panel/ panel/
RUN npm run construir && npm run construir --workspace panel
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000 PANEL_DIST=/app/panel/dist \
    ALMACEN_OBJETOS_RAIZ=/app/datos/evidencias MIGRAR_AL_INICIAR=true
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/compartido/package.json ./compartido/package.json
COPY --from=build /app/compartido/dist ./compartido/dist
COPY --from=build /app/servidor/package.json ./servidor/package.json
COPY --from=build /app/servidor/dist ./servidor/dist
COPY --from=build /app/panel/dist ./panel/dist
COPY base-datos/migraciones/ ./base-datos/migraciones/
COPY --chmod=755 docker/iniciar.sh /usr/local/bin/servitotal
RUN mkdir -p /app/datos/evidencias && chown -R node:node /app/datos
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/listo').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["servitotal"]
CMD ["node", "servidor/dist/servidor.js"]

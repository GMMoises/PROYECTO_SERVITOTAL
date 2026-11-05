# Docker y CI CD de ServiTotal

Adaptación para https://github.com/antonysa0402/PROYECTO_SERVITOTAL de la
[guía de Pokemondemo](https://github.com/CristopherLarios/Pokemondemo/blob/DOCKERCICD/DOCKER-CICD.md).

## Arquitectura

```text
Navegador -> Express (panel React compilado + /api/v1) -> PostgreSQL
                       |
                       +-> volumen persistente de evidencias

Push / PR -> tipos + compilación + pruebas con PostgreSQL
          -> construir imagen -> probar contenedor
          -> GHCR (solo rama predeterminada)
          -> Render (si se habilita CD) -> esperar live -> prueba pública
```

Una imagen Node 24 ejecuta el monolito y sirve el panel desde el mismo origen.
No necesita nginx ni un segundo servicio para React. Vite sigue funcionando
como antes para desarrollo. El fallback de rutas SPA no intercepta `/api`.

## Ejecutar localmente con Docker Desktop

Requiere Docker Desktop iniciado, Compose v2 y contenedores Linux.

1. Copiar `.env.ejemplo` a `.env`. Cambiar `DATABASE_PASSWORD` y `JWT_SECRET`
   por valores propios. JWT debe tener al menos 32 caracteres. Para generar
   un secreto: `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"`.
2. Ejecutar desde la raíz:

```powershell
docker compose config --quiet
docker compose up --build -d
docker compose ps
docker compose logs -f app
```

Abrir http://localhost:8080. Compose configura internamente el host, usuario
y nombre de la base; de `.env` utiliza su contraseña y el secreto JWT.
`APP_PORT` permite cambiar 8080. PostgreSQL no publica un puerto al host.

La API ejecuta las migraciones SQL compiladas antes de escuchar. Si fallan,
el proceso falla y el error aparece en sus logs; no continúa con un esquema
incompleto. **No se siembran ni borran datos automáticamente.**

Solo para una base local de demostración vacía se pueden generar los datos
y cuentas de prueba descritos en `GUIA_LOCAL.md`:

```powershell
docker compose exec app node servidor/dist/infraestructura/semillas/cli.js
```

La siembra vacía y regenera datos: no ejecutarla sobre datos reales ni
incluirla en un despliegue de producción. La provisión del primer usuario
real debe planificarse antes de habilitar acceso al taller.

Para detener conservando los volúmenes: `docker compose down`.
No agregar `--volumes` si se quieren conservar PostgreSQL y las evidencias.
La contraseña de un volumen PostgreSQL existente no cambia simplemente
editando `.env`; hay que cambiarla en PostgreSQL y en la aplicación.

## Qué comprueba GitHub Actions

El workflow `.github/workflows/ci-cd.yml` se ejecuta en PR, en pushes a
`main`, `master` y `DOCKERCICD`, y manualmente desde Actions. Si la rama
predeterminada tiene otro nombre, agregarla a `on.push.branches`.

- Instala según `package-lock.json` con Node 24.
- Comprueba tipos; compila compartido, servidor y panel.
- Ejecuta toda la suite del servidor con PostgreSQL 16 desechable y las
  pruebas del panel. El usuario PostgreSQL de CI puede crear bases, ya que
  las pruebas crean bases y plantillas aisladas.
- Construye la imagen y arranca el contenedor contra la base de CI.
- Comprueba `/api/v1/listo` con una consulta real a PostgreSQL, el panel,
  una ruta SPA y que una ruta API desconocida siga devolviendo JSON.
- Solo en la rama predeterminada, publica **esa misma imagen probada** en
  `ghcr.io/antonysa0402/proyecto_servitotal`, con `latest` y `sha-<commit completo>`.
- Los PR y `DOCKERCICD` validan sin publicar ni desplegar, salvo que
  `DOCKERCICD` sea la rama predeterminada.

`/api/v1/salud` indica que el proceso responde. `/api/v1/listo` también
comprueba conectividad SQL; no sustituye una prueba de negocio completa.

## Primera publicación en GHCR

Subir estos archivos al repositorio GitHub y ejecutar el workflow en la
rama predeterminada. Esta carpeta descargada no incluye `.git`; no hay
historial ni remoto configurado aquí. Copiar los cambios a un clon propio
antes de hacer commit y push, evitando incluir `.env`, `node_modules`,
`datos`, `tmp` y los informes de `output`.

`GITHUB_TOKEN` se genera automáticamente. El job tiene `packages: write`.
En GitHub, revisar Actions y después Packages. Para que Render pueda
descargar sin credenciales, hacer pública la imagen desde Package settings.
Si se mantiene privada, configurar acceso al registro en Render.

## Configurar Render

1. Crear PostgreSQL en Render y un Web Service de tipo **Existing Image**
   con `ghcr.io/antonysa0402/proyecto_servitotal:latest`.
2. Elegir la misma región y conectar por la red interna de Render. Configurar
   `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME`, `DATABASE_USER` y
   `DATABASE_PASSWORD` con los valores de esa base. No pegar una URL completa
   en `DATABASE_HOST`: el backend utiliza variables separadas. Para una base
   externa que exija TLS, adaptar primero el controlador, que actualmente
   no configura SSL explícito.
3. Configurar `JWT_SECRET` con un secreto propio; `NODE_ENV=production`;
   `ALMACEN_OBJETOS_RAIZ=/app/datos/evidencias`; `MIGRAR_AL_INICIAR=true`.
   La imagen ya define estos valores excepto credenciales y JWT.
   Render proporciona `PORT`; la aplicación lo respeta.
4. Adjuntar un disco persistente en `/app/datos` y comprobar permiso de
   escritura para el usuario `node` (UID 1000). El almacenamiento actual
   guarda evidencias en archivos locales. **Render requiere un servicio de
   pago para disco persistente**; el filesystem sin disco pierde archivos
   al reiniciar o redesplegar. Si se necesita otro modelo, implementar S3
   o equivalente antes de usar evidencias reales.
5. Usar `/api/v1/listo` como Health Check Path. Dejar el comando de inicio
   predeterminado de la imagen: ejecuta migraciones y después el servidor.
6. Esperar el primer despliegue y comprobar panel, conexión, inicio de sesión
   con un usuario provisionado y una operación de negocio. Configurar copias
   de seguridad de PostgreSQL y evidencias antes de operar con datos reales.

Esta configuración usa **una sola instancia**. El disco persistente de
Render limita el escalado a una instancia y hay interrupción al redesplegar.
Las migraciones al inicio presuponen ese modelo; si se cambia a varias
réplicas, ejecutarlas como una fase coordinada independiente.

## Activar despliegue continuo

En GitHub, crear el environment `production`. Configurar en ese environment
o en el repositorio estos valores:

| Tipo | Nombre | Valor |
|---|---|---|
| Secret | `RENDER_DEPLOY_HOOK_URL` | Deploy Hook completo del servicio Render |
| Secret | `RENDER_API_KEY` | API key con acceso para consultar el despliegue |
| Variable | `RENDER_SERVICE_ID` | Identificador `srv-...` del mismo servicio |
| Variable | `RENDER_PUBLIC_URL` | URL HTTPS pública de ese servicio |

Por último, crear **a nivel de repositorio** la variable
`RENDER_CD_ENABLED=true`. Se consulta antes de entrar al environment.
Hasta habilitarla, Actions compila, prueba y publica, y omite CD sin fallar
por falta de cuentas o secretos.

El hook envía `imgURL` con la etiqueta del commit probado, no depende de que
`latest` siga apuntando al mismo commit. Después consulta el ID de despliegue
mediante la API de Render y espera estado `live`; si falla o vence el plazo,
falla el job. Finalmente comprueba la URL pública. Un hook aceptado por sí
solo no se presenta como despliegue terminado. Si Render responde 202 porque
ya existe otro despliegue en curso, este workflow falla sin atribuirse el
resultado de otro despliegue; esperar su fin y volver a ejecutar CD.

No guardar hooks, contraseñas ni API keys en código, capturas o informes.

## Recuperación y evidencia de entrega

Para volver a una versión, indicar en Render la imagen
`ghcr.io/antonysa0402/proyecto_servitotal:sha-<commit anterior validado>`.
Cambiar la imagen no deshace migraciones: comprobar compatibilidad y respaldos
antes de recuperar una versión.

Conservar para la entrega: commit, enlace de Actions aprobado, etiqueta de
imagen en Packages, URL pública y prueba de registro/consulta de una orden
y persistencia de una evidencia después de reiniciar. Crear un cambio pequeño,
hacer push y verificar que el commit llega a Render sin intervención manual.

## Referencias

- [Guía original Docker y CI/CD](https://github.com/CristopherLarios/Pokemondemo/blob/DOCKERCICD/DOCKER-CICD.md)
- [Render Deploy Hooks](https://render.com/docs/deploy-hooks)
- [Render Persistent Disks](https://render.com/docs/disks)
- [Render consulta de despliegue](https://api-docs.render.com/reference/retrieve-deploy)

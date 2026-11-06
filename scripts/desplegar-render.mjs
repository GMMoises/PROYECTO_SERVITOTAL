// El hook inicia el despliegue; la API confirma que ESE despliegue termino.
const { RENDER_DEPLOY_HOOK_URL: hook, RENDER_API_KEY: key,
  RENDER_SERVICE_ID: service, DEPLOY_COMMIT: commit } = process.env;
if (!hook || !key || !service || !commit) {
  throw new Error('Faltan RENDER_DEPLOY_HOOK_URL, RENDER_API_KEY, RENDER_SERVICE_ID o DEPLOY_COMMIT.');
}
const url = new URL(hook);
if (url.protocol !== 'https:' || url.hostname !== 'api.render.com') {
  throw new Error('El deploy hook debe ser una URL HTTPS de api.render.com.');
}
url.searchParams.set('ref', commit);
// No imprimir la URL: contiene la clave secreta del hook.
const respuesta = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(30000) });
if (respuesta.status !== 200) throw new Error(`Render no inicio un despliegue identificable (HTTP ${respuesta.status}). Revise si existe otro en curso.`);
const cuerpo = await respuesta.json();
const id = cuerpo.deploy?.id;
if (!id) throw new Error('Render no devolvio el identificador del despliegue.');
const estadoURL = `https://api.render.com/v1/services/${encodeURIComponent(service)}/deploys/${encodeURIComponent(id)}`;
for (let intento = 0; intento < 100; intento++) {
  await new Promise(resolve => setTimeout(resolve, 10000));
  const estado = await fetch(estadoURL, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
  if (!estado.ok) throw new Error(`No se pudo consultar Render (HTTP ${estado.status}).`);
  const despliegue = await estado.json();
  if (despliegue.status === 'live') {
    console.log(`Despliegue ${id} activo: ${commit}`);
    process.exit(0);
  }
  if (['build_failed', 'update_failed', 'pre_deploy_failed', 'canceled', 'deactivated'].includes(despliegue.status)) {
    throw new Error(`El despliegue termino con estado ${despliegue.status}.`);
  }
}
throw new Error('Render no confirmo el despliegue dentro del plazo.');

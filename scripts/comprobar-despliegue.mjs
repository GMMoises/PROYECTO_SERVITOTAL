// Sin dependencias: verifica el panel, readiness con BD y el contrato de errores.
import assert from 'node:assert/strict';
const base = process.argv[2] || process.env.PUBLIC_URL;
if (!base) throw new Error('Defina PUBLIC_URL o indique la URL como argumento.');
const url = new URL(base);
const esperar = ms => new Promise(resolve => setTimeout(resolve, ms));
let listo = false;
for (let intento = 0; intento < 90; intento++) {
  try {
    const respuesta = await fetch(new URL('/api/v1/listo', url), { signal: AbortSignal.timeout(5000) });
    if (respuesta.ok && (await respuesta.json()).datos.estado === 'listo') {
      listo = true;
      break;
    }
  } catch { /* El proceso puede seguir aplicando migraciones. */ }
  await esperar(2000);
}
assert.ok(listo, 'La API no esta lista o no puede consultar PostgreSQL.');
for (const ruta of ['/', '/consulta']) {
  const respuesta = await fetch(new URL(ruta, url), { signal: AbortSignal.timeout(10000) });
  assert.equal(respuesta.status, 200, `Panel no disponible en ${ruta}`);
  assert.match(await respuesta.text(), /<div[^>]+id=["']raiz["']/);
}
const desconocida = await fetch(new URL('/api/v1/ruta-inexistente-ci', url), { signal: AbortSignal.timeout(10000) });
assert.ok([401, 404].includes(desconocida.status));
assert.match(desconocida.headers.get('content-type') || '', /application\/json/);
console.log('Panel, rutas SPA, API y conexion PostgreSQL verificados.');

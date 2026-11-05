import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { construirAplicacion } from '../../src/aplicacion.js';
import * as conexion from '../../src/infraestructura/conexion.js';

let carpeta: string;
beforeAll(async () => {
  carpeta = await mkdtemp(path.join(os.tmpdir(), 'servitotal-panel-'));
  await writeFile(path.join(carpeta, 'index.html'), '<html><div id="raiz">Panel</div></html>');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => { await rm(carpeta, { recursive: true, force: true }); });

describe('Despliegue de panel y API', () => {
  it('sirve el panel y permite recargar una ruta SPA', async () => {
    vi.stubEnv('PANEL_DIST', carpeta);
    const app = construirAplicacion();
    for (const ruta of ['/', '/consulta']) {
      const respuesta = await request(app).get(ruta).expect(200);
      expect(respuesta.text).toContain('id="raiz"');
    }
  });
  it('no transforma una ruta API desconocida en HTML', async () => {
    vi.stubEnv('PANEL_DIST', carpeta);
    const respuesta = await request(construirAplicacion()).get('/api/v1/no-existe');
    expect([401, 404]).toContain(respuesta.status);
    expect(respuesta.headers['content-type']).toContain('application/json');
  });
  it('no sirve el panel cuando no esta configurado', async () => {
    vi.stubEnv('PANEL_DIST', '');
    await request(construirAplicacion()).get('/consulta').expect(404);
  });
  it('comprueba la BD al indicar que esta listo', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] });
    vi.spyOn(conexion, 'obtenerPiscina').mockReturnValue({ query } as unknown as ReturnType<typeof conexion.obtenerPiscina>);
    const respuesta = await request(construirAplicacion()).get('/api/v1/listo').expect(200);
    expect(query).toHaveBeenCalledWith({ text: 'SELECT 1', query_timeout: 3000 });
    expect(respuesta.body.datos.estado).toBe('listo');
  });
  it('devuelve 503 sin revelar detalles de conexion si falla la BD', async () => {
    const query = vi.fn().mockRejectedValue(new Error('password=secreto-interno'));
    vi.spyOn(conexion, 'obtenerPiscina').mockReturnValue({ query } as unknown as ReturnType<typeof conexion.obtenerPiscina>);
    const respuesta = await request(construirAplicacion()).get('/api/listo').expect(503);
    expect(respuesta.body.datos.estado).toBe('no_disponible');
    expect(respuesta.text).not.toContain('secreto-interno');
  });
});

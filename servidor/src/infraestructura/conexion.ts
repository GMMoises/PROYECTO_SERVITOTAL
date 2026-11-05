/**
 * Conexion a PostgreSQL. Unico punto donde el proceso abre sockets a la
 * base; ningun modulo crea su propio Pool.
 */
import pg from 'pg';
import { leerConfiguracionBaseDatos } from '../comun/configuracion.js';
import { bitacora } from '../comun/bitacora.js';

const { Pool, types } = pg;

// numeric(12,2) llega como cadena por defecto para no perder precision.
// En este sistema los montos caben de sobra en un double, y los informes y
// las pruebas los comparan como numeros.
types.setTypeParser(types.builtins.NUMERIC, (valor: string) => Number.parseFloat(valor));
// bigint (orden_servicio.numero): cabe en Number.MAX_SAFE_INTEGER.
types.setTypeParser(types.builtins.INT8, (valor: string) => Number.parseInt(valor, 10));

let piscina: pg.Pool | undefined;

export function obtenerPiscina(): pg.Pool {
  if (piscina !== undefined) return piscina;
  const configuracion = leerConfiguracionBaseDatos();
  piscina = new Pool({
    host: configuracion.host,
    port: configuracion.puerto,
    database: configuracion.nombre,
    user: configuracion.usuario,
    password: configuracion.contrasena,
    max: configuracion.maxConexiones,
    // Evita que readiness y peticiones queden esperando una BD inaccesible.
    connectionTimeoutMillis: 3000,
  });
  piscina.on('error', (error) => {
    bitacora.error('Error inesperado en una conexion inactiva de la piscina', { detalle: String(error) });
  });
  return piscina;
}

export async function cerrarPiscina(): Promise<void> {
  if (piscina === undefined) return;
  const actual = piscina;
  piscina = undefined;
  await actual.end();
}

/**
 * Ejecuta el trabajo dentro de una transaccion: se confirma entera o se
 * revierte entera (regla de arquitectura 8).
 */
export async function enTransaccion<T>(trabajo: (cliente: pg.PoolClient) => Promise<T>): Promise<T> {
  const cliente = await obtenerPiscina().connect();
  try {
    await cliente.query('BEGIN');
    const resultado = await trabajo(cliente);
    await cliente.query('COMMIT');
    return resultado;
  } catch (error) {
    await cliente.query('ROLLBACK');
    throw error;
  } finally {
    cliente.release();
  }
}

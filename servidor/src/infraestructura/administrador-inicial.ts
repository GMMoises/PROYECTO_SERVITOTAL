import { CATALOGO_PERMISOS, CODIGO_ROL } from '@servitotal/compartido';
import { derivarContrasena } from '../comun/contrasenas.js';
import { cerrarPiscina, enTransaccion } from './conexion.js';

async function crearAdministradorInicial(): Promise<void> {
  const clave = process.env['ADMIN_INICIAL_PASSWORD'];
  if (!clave) return;
  const nombre = process.env['ADMIN_INICIAL_USUARIO'] ?? 'admin';
  await enTransaccion(async cliente => {
    // Serializa arranques concurrentes y limita la provision a una base sin usuarios.
    await cliente.query('LOCK TABLE usuario IN EXCLUSIVE MODE');
    const existentes = await cliente.query('SELECT 1 FROM usuario LIMIT 1');
    if (existentes.rowCount) {
      console.log('Provision inicial omitida: ya existen usuarios.');
      return;
    }
    if (clave.length < 16 || !/^[a-zA-Z0-9_.-]{3,50}$/.test(nombre)) {
      throw new Error('El administrador inicial requiere usuario valido y clave de al menos 16 caracteres.');
    }
    let centro = await cliente.query('SELECT id FROM centro WHERE activo ORDER BY creado_en LIMIT 1');
    if (!centro.rowCount) {
      centro = await cliente.query("INSERT INTO centro(nombre,distrito) VALUES ('ServiTotal','VI') RETURNING id");
    }
    const rol = await cliente.query(
      `INSERT INTO rol(codigo,nombre) VALUES ($1,'Administrador del sistema')
       ON CONFLICT(codigo) DO UPDATE SET activo=true RETURNING id`, [CODIGO_ROL.ADMINISTRADOR]);
    for (const permiso of CATALOGO_PERMISOS) {
      const resultado = await cliente.query(
        `INSERT INTO permiso(codigo,modulo,descripcion) VALUES ($1,$2,$3)
         ON CONFLICT(codigo) DO UPDATE SET descripcion=EXCLUDED.descripcion RETURNING id`,
        [permiso.codigo, permiso.modulo, permiso.descripcion]);
      await cliente.query('INSERT INTO rol_permiso(id_rol,id_permiso) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [rol.rows[0].id, resultado.rows[0].id]);
    }
    await cliente.query(
      `INSERT INTO usuario(id_centro,id_rol,nombre_usuario,nombres,contrasena_hash)
       VALUES ($1,$2,$3,'Administrador ServiTotal',$4)`,
      [centro.rows[0].id, rol.rows[0].id, nombre, derivarContrasena(clave)]);
    console.log('Administrador inicial creado correctamente. Retire ADMIN_INICIAL_PASSWORD del entorno.');
  });
}

crearAdministradorInicial().catch(() => {
  console.error('Fallo al crear el administrador inicial. Revise la configuracion y la base de datos.');
  process.exitCode = 1;
}).finally(() => cerrarPiscina());

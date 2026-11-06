/**
 * Ordenes contra la base real: creacion, maquina de estados, plazos en
 * horas laborables y notas de correccion.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import peticion from 'supertest';
import { CODIGO_ROL, ESTADO_ORDEN, MODALIDAD_SERVICIO, TIPO_GARANTIA } from '@servitotal/compartido';
import { CONTRASENA_DE_PRUEBA, montarApi, usuarioConRol, type EntornoApi } from '../apoyo/entorno-api.js';

const RAIZ = '/api/v1';
let entorno: EntornoApi;
let jefatura: { Authorization: string };
let agente: { Authorization: string };
let jefeTecnicos: { Authorization: string };

async function sesionDe(codigoRol: string): Promise<{ Authorization: string }> {
  const nombreUsuario = await usuarioConRol(entorno.piscina, codigoRol);
  const sesion = await peticion(entorno.aplicacion)
    .post(`${RAIZ}/autenticacion/sesion`)
    .send({ nombreUsuario, contrasena: CONTRASENA_DE_PRUEBA }).expect(201);
  return { Authorization: `Bearer ${sesion.body.data.tokenAcceso}` };
}

/** Cliente con articulo propio comprado en el grupo, para tener cobertura. */
async function clienteConArticulo(): Promise<{ idCliente: string; idArticulo: string }> {
  const { rows } = await entorno.piscina.query<{ id_cliente: string; id: string }>(
    `SELECT a.id_cliente, a.id
       FROM articulo a JOIN tienda_origen t ON t.id = a.id_tienda_origen
       JOIN cliente c ON c.id = a.id_cliente
      WHERE t.pertenece_al_grupo AND a.fecha_compra > current_date - interval '6 months'
        AND c.activo AND c.id_cliente_principal IS NULL
        AND EXISTS (SELECT 1 FROM cliente_telefono WHERE id_cliente = c.id AND vigente)
      ORDER BY a.creado_en LIMIT 1`,
  );
  return { idCliente: rows[0]!.id_cliente, idArticulo: rows[0]!.id };
}

async function idTecnico(tipo: 'ruta' | 'planta'): Promise<string> {
  const { rows } = await entorno.piscina.query<{ id: string }>(
    'SELECT id FROM tecnico WHERE tipo = $1 AND activo ORDER BY id LIMIT 1', [tipo],
  );
  return rows[0]!.id;
}

/** Sesion del usuario dueno de una ficha de tecnico. */
async function sesionDelTecnico(idTec: string): Promise<{ Authorization: string }> {
  const { rows } = await entorno.piscina.query<{ nombre_usuario: string }>(
    'SELECT u.nombre_usuario FROM tecnico t JOIN usuario u ON u.id = t.id_usuario WHERE t.id = $1',
    [idTec],
  );
  const sesion = await peticion(entorno.aplicacion)
    .post(`${RAIZ}/autenticacion/sesion`)
    .send({ nombreUsuario: rows[0]!.nombre_usuario, contrasena: CONTRASENA_DE_PRUEBA }).expect(201);
  return { Authorization: `Bearer ${sesion.body.data.tokenAcceso}` };
}

async function crearOrden(cuerpo: Record<string, unknown> = {}): Promise<{ id: string; numero: number }> {
  const base = await clienteConArticulo();
  const respuesta = await peticion(entorno.aplicacion).post(`${RAIZ}/ordenes`).set(agente)
    .send({
      idCliente: base.idCliente, idArticulo: base.idArticulo,
      modalidad: MODALIDAD_SERVICIO.TALLER, tipoGarantiaElegida: 'proveedor', fallaReportada: 'No enfria bien',
      ...cuerpo,
    }).expect(201);
  return { id: respuesta.body.data.id, numero: respuesta.body.data.numero };
}

/** Carga la evidencia que falta para poder salir del estado actual. */
async function cargarEvidenciaPendiente(idOrden: string, momento: string): Promise<void> {
  const { rows } = await entorno.piscina.query<{ clave: string; tipo: string }>(
    `SELECT DISTINCT re.clave,
            CASE WHEN re.clave LIKE 'firma%' THEN 'firma'
                 WHEN re.clave LIKE 'foto%' THEN 'foto'
                 WHEN re.clave LIKE 'medicion%' THEN 'medicion'
                 ELSE 'documento' END AS tipo
       FROM orden_servicio o
       JOIN articulo a ON a.id = o.id_articulo
       JOIN regla_evidencia re
         ON re.tipo = o.tipo_garantia AND re.activa AND re.obligatoria AND re.bloquea_avance
        AND re.momento = $2::momento_evidencia
        AND (re.id_categoria IS NULL OR re.id_categoria = a.id_categoria)
        AND (re.id_marca IS NULL OR re.id_marca = a.id_marca)
      WHERE o.id = $1
        AND NOT EXISTS (SELECT 1 FROM evidencia ev WHERE ev.id_orden = o.id AND ev.clave = re.clave)`,
    [idOrden, momento],
  );
  for (const fila of rows) {
    await entorno.piscina.query(
      `INSERT INTO evidencia (id_orden, tipo, clave, ruta_archivo, momento_dispositivo, sincronizada)
       VALUES ($1, $2::tipo_evidencia, $3, $4, now(), true)`,
      [idOrden, fila.tipo, fila.clave, `pruebas/${idOrden}/${fila.clave}.jpg`],
    );
  }
}

/** Devuelve la cadena de supertest sin envolverla, para poder encadenar .expect(). */
function mover(
  cabecera: { Authorization: string }, idOrden: string, hacia: string, extra: Record<string, unknown> = {},
) {
  return peticion(entorno.aplicacion).post(`${RAIZ}/ordenes/${idOrden}/estado`)
    .set(cabecera).send({ hacia, ...extra });
}

beforeAll(async () => {
  entorno = await montarApi();
  jefatura = await sesionDe(CODIGO_ROL.JEFE_ATENCION_CLIENTE);
  agente = await sesionDe(CODIGO_ROL.AGENTE_TELEFONIA);
  jefeTecnicos = await sesionDe(CODIGO_ROL.JEFE_TECNICOS);
});

afterAll(async () => { await entorno.cerrar(); });

describe('creacion de la orden', () => {
  it('el servidor asigna el numero correlativo, no el cliente', async () => {
    const primera = await crearOrden();
    const segunda = await crearOrden();

    expect(segunda.numero).toBe(primera.numero + 1);
    expect(primera.numero).toBeGreaterThanOrEqual(10_000);
  });

  it('acepta el UUID que genera el dispositivo movil', async () => {
    const base = await clienteConArticulo();
    const idPropio = '5f2c1e7a-0b4d-4a91-8c3e-77a1b2c3d4e5';

    const creada = await peticion(entorno.aplicacion).post(`${RAIZ}/ordenes`).set(agente)
      .send({
        id: idPropio, idCliente: base.idCliente, idArticulo: base.idArticulo,
        modalidad: MODALIDAD_SERVICIO.RUTA, tipoGarantiaElegida: 'proveedor', fallaReportada: 'Hace ruido al arrancar',
        levantadaEnCampo: true,
      }).expect(201);

    expect(creada.body.data.id).toBe(idPropio);
    expect(creada.body.data.numero).toBeTypeOf('number');
    expect(creada.body.data.levantadaEnCampo).toBe(true);

    // Reenviarla no la duplica: avisa que ya llego.
    const reenvio = await peticion(entorno.aplicacion).post(`${RAIZ}/ordenes`).set(agente)
      .send({
        id: idPropio, idCliente: base.idCliente, idArticulo: base.idArticulo,
        modalidad: MODALIDAD_SERVICIO.RUTA, tipoGarantiaElegida: 'proveedor', fallaReportada: 'Hace ruido al arrancar',
      });
    expect(reenvio.status).toBe(409);
    expect(reenvio.body.error.message).toMatch(/ya llego bien/);
  });

  it('congela los datos de contacto y ubicacion al crearse', async () => {
    const base = await clienteConArticulo();
    const creada = await peticion(entorno.aplicacion).post(`${RAIZ}/ordenes`).set(agente)
      .send({
        idCliente: base.idCliente, idArticulo: base.idArticulo,
        modalidad: MODALIDAD_SERVICIO.RUTA, tipoGarantiaElegida: 'proveedor', fallaReportada: 'No enciende',
      }).expect(201);

    expect(creada.body.data.telefonoContacto).toMatch(/^\d{8}$/);
    expect(creada.body.data.direccionServicio).toBeTypeOf('string');
    expect(creada.body.data.cargoVisita).toBeGreaterThan(0);

    // Cambiar la ficha del cliente no mueve la orden.
    await peticion(entorno.aplicacion).post(`${RAIZ}/clientes/${base.idCliente}/telefonos`)
      .set(jefatura).send({ numero: '89990000', reemplazaAlVigente: true }).expect(201);

    const ficha = await peticion(entorno.aplicacion)
      .get(`${RAIZ}/ordenes/${creada.body.data.id}`).set(agente).expect(200);
    expect(ficha.body.data.telefonoContacto).toBe(creada.body.data.telefonoContacto);
    expect(ficha.body.data.telefonoContacto).not.toBe('89990000');
  });

  it('una orden de taller no arrastra cargo por visita', async () => {
    const creada = await crearOrden({ modalidad: MODALIDAD_SERVICIO.TALLER });
    const ficha = await peticion(entorno.aplicacion)
      .get(`${RAIZ}/ordenes/${creada.id}`).set(agente).expect(200);
    expect(ficha.body.data.cargoVisita).toBe(0);
    expect(ficha.body.data.direccionServicio).toBeNull();
  });

  it('registra la garantia elegida, quien y cuando la decidio, y guarda la regla de referencia', async () => {
    const creada = await crearOrden();
    const ficha = await peticion(entorno.aplicacion)
      .get(`${RAIZ}/ordenes/${creada.id}`).set(agente).expect(200);

    expect(ficha.body.data.tipoGarantia).toBe(TIPO_GARANTIA.PROVEEDOR);
    expect(ficha.body.data.idReglaCobertura).toBeTypeOf('string');
    expect(ficha.body.data.eventos[0].observacion).toMatch(/Garantia: proveedor\. Elegida al registrar/);

    const { rows } = await entorno.piscina.query<{ valor_nuevo: string; id_usuario: string; momento: Date }>(
      `SELECT valor_nuevo, id_usuario, momento FROM bitacora
        WHERE tabla = 'orden_servicio' AND id_registro = $1 AND campo = 'tipo_garantia'`, [creada.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.valor_nuevo).toBe(TIPO_GARANTIA.PROVEEDOR);
    expect(rows[0]!.id_usuario).toBeTypeOf('string');
    expect(rows[0]!.momento).toBeInstanceOf(Date);
  });

  it('sin elegir la garantia no se registra la orden', async () => {
    const base = await clienteConArticulo();
    const respuesta = await peticion(entorno.aplicacion).post(`${RAIZ}/ordenes`).set(agente)
      .send({
        idCliente: base.idCliente, idArticulo: base.idArticulo,
        modalidad: MODALIDAD_SERVICIO.TALLER, fallaReportada: 'No enfria bien',
      });
    expect(respuesta.status).toBe(400);
    expect(respuesta.body.error.fields).toHaveProperty('tipoGarantiaElegida');
  });

  it('nace con plazo calculado y arranca en registrada', async () => {
    const creada = await crearOrden();
    const ficha = await peticion(entorno.aplicacion)
      .get(`${RAIZ}/ordenes/${creada.id}`).set(agente).expect(200);

    expect(ficha.body.data.estado).toBe(ESTADO_ORDEN.REGISTRADA);
    expect(ficha.body.data.plazoVenceEn).toBeTypeOf('string');
    expect(ficha.body.data.horasParaVencer).toBeGreaterThan(0);
    expect(ficha.body.data.vencida).toBe(false);
    expect(ficha.body.data.destinosPosibles).toContain(ESTADO_ORDEN.ASIGNADA);
  });

  it('rechaza un cliente o un articulo que no existen', async () => {
    const base = await clienteConArticulo();
    const respuesta = await peticion(entorno.aplicacion).post(`${RAIZ}/ordenes`).set(agente)
      .send({
        idCliente: base.idCliente, idArticulo: '00000000-0000-4000-8000-000000000000',
        modalidad: MODALIDAD_SERVICIO.TALLER, tipoGarantiaElegida: 'proveedor', fallaReportada: 'Lo que sea',
      });
    expect(respuesta.status).toBe(400);
    expect(respuesta.body.error.fields.idArticulo).toBeTypeOf('string');
  });
});

describe('maquina de estados sobre la API', () => {
  it('una transicion invalida falla diciendo a donde si se puede ir', async () => {
    const creada = await crearOrden();
    const respuesta = await mover(jefeTecnicos, creada.id, ESTADO_ORDEN.ENTREGADA);

    expect(respuesta.status).toBe(422);
    expect(respuesta.body.error.code).toBe('TRANSICION_INVALIDA');
    expect(respuesta.body.error.message).toMatch(/solo se puede ir a/);
    expect(respuesta.body.error.message).toContain(ESTADO_ORDEN.ASIGNADA);
  });

  it('no avanza sin la evidencia obligatoria, y dice cual falta', async () => {
    const creada = await crearOrden();
    const idTec = await idTecnico('planta');
    await peticion(entorno.aplicacion).put(`${RAIZ}/ordenes/${creada.id}/tecnico`)
      .set(jefeTecnicos).send({ idTecnico: idTec }).expect(200);

    const sinEvidencia = await mover(agente, creada.id, ESTADO_ORDEN.ASIGNADA);
    expect(sinEvidencia.status).toBe(422);
    expect(sinEvidencia.body.error.code).toBe('REQUISITO_INCUMPLIDO');
    expect(sinEvidencia.body.error.message).toMatch(/evidencia obligatoria/i);

    await cargarEvidenciaPendiente(creada.id, 'recepcion');
    await mover(agente, creada.id, ESTADO_ORDEN.ASIGNADA).expect(200);
  });

  it('recorre el camino completo de una orden de taller hasta entregarla', async () => {
    const creada = await crearOrden();
    const idTec = await idTecnico('planta');
    const tecnico = await sesionDelTecnico(idTec);

    await peticion(entorno.aplicacion).put(`${RAIZ}/ordenes/${creada.id}/tecnico`)
      .set(jefeTecnicos).send({ idTecnico: idTec }).expect(200);

    await cargarEvidenciaPendiente(creada.id, 'recepcion');
    await mover(agente, creada.id, ESTADO_ORDEN.ASIGNADA).expect(200);

    await cargarEvidenciaPendiente(creada.id, 'validacion_garantia');
    await mover(jefeTecnicos, creada.id, ESTADO_ORDEN.EN_COLA_TALLER).expect(200);
    await mover(jefeTecnicos, creada.id, ESTADO_ORDEN.EN_DIAGNOSTICO).expect(200);

    await entorno.piscina.query(
      `INSERT INTO diagnostico (id_orden, id_tecnico, falla_real, momento_dispositivo)
       VALUES ($1, $2, 'Compresor en corto por desgaste', now())`,
      [creada.id, idTec],
    );
    await cargarEvidenciaPendiente(creada.id, 'diagnostico');
    await mover(tecnico, creada.id, ESTADO_ORDEN.EN_REPARACION).expect(200);

    await cargarEvidenciaPendiente(creada.id, 'reparacion');
    const finalizada = await mover(tecnico, creada.id, ESTADO_ORDEN.FINALIZADA);
    expect(finalizada.status).toBe(200);

    await cargarEvidenciaPendiente(creada.id, 'entrega');

    // Mover el estado a «entregada» a pelo ya no se puede: hace falta el
    // acta, y el acta exige la revision tecnica. Era la puerta de atras.
    const atajo = await mover(agente, creada.id, ESTADO_ORDEN.ENTREGADA);
    expect(atajo.status).toBe(422);
    expect(atajo.body.error.message).toMatch(/Entregar el articulo/);

    await peticion(entorno.aplicacion).post(`${RAIZ}/ordenes/${creada.id}/validaciones`)
      .set(jefeTecnicos).send({
        resultado: 'aprobada', observacion: 'Compresor sustituido y probado: enfria a -18 C.',
        revisoDiagnostico: true, revisoReparacion: true, revisoEvidencias: true, revisoRepuestos: true,
      }).expect(201);

    // Y se entrega sin registrar ningun pago: el sistema no gestiona dinero.
    const entregada = await peticion(entorno.aplicacion).post(`${RAIZ}/ordenes/${creada.id}/entrega`)
      .set(jefatura).send({ recibidoPor: 'El titular de la orden', esElCliente: true });
    expect(entregada.status).toBe(201);
    const { rows: pagos } = await entorno.piscina.query(
      'SELECT 1 FROM pago WHERE id_orden = $1', [creada.id],
    );
    expect(pagos).toHaveLength(0);

    const ficha = await peticion(entorno.aplicacion)
      .get(`${RAIZ}/ordenes/${creada.id}`).set(agente).expect(200);
    expect(ficha.body.data.estado).toBe(ESTADO_ORDEN.ENTREGADA);
    // El plazo de una orden entregada YA NO CORRE, pero no se borra: se
    // conserva el ultimo vigente porque es el registro de lo que se le
    // prometio al cliente, y es contra el que se mide el cumplimiento.
    expect(ficha.body.data.plazoVenceEn).toBeTypeOf('string');
    expect(ficha.body.data.fechaEntrega).toBeTypeOf('string');
    expect(ficha.body.data.destinosPosibles).toHaveLength(0);
    // Y aunque tenga plazo grabado, no aparece como vencida: todo lo que
    // pregunta "¿esta vencida?" excluye los estados finales.
    expect(ficha.body.data.vencida).toBe(false);
    // La bitacora conserva cada paso.
    expect(ficha.body.data.eventos.length).toBeGreaterThanOrEqual(7);
  });

  it('el responsable de turno es quien mueve la orden', async () => {
    const creada = await crearOrden();
    const idTec = await idTecnico('planta');
    await peticion(entorno.aplicacion).put(`${RAIZ}/ordenes/${creada.id}/tecnico`)
      .set(jefeTecnicos).send({ idTecnico: idTec }).expect(200);
    await cargarEvidenciaPendiente(creada.id, 'recepcion');

    // Un bodeguero no mueve una orden que esta en manos del agente.
    const bodeguero = await sesionDe(CODIGO_ROL.BODEGUERO);
    const respuesta = await mover(bodeguero, creada.id, ESTADO_ORDEN.ASIGNADA);
    expect(respuesta.status).toBe(422);
    expect(respuesta.body.error.code).toBe('NO_ES_RESPONSABLE');
  });

  it('anular exige motivo escrito y lo guarda', async () => {
    const creada = await crearOrden();

    const sinMotivo = await mover(jefatura, creada.id, ESTADO_ORDEN.ANULADA);
    expect(sinMotivo.status).toBe(422);
    expect(sinMotivo.body.error.message).toMatch(/Escriba el motivo/);

    await mover(jefatura, creada.id, ESTADO_ORDEN.ANULADA, {
      motivo: 'El cliente desistio del servicio y pidio que se cerrara',
    }).expect(200);

    const ficha = await peticion(entorno.aplicacion)
      .get(`${RAIZ}/ordenes/${creada.id}`).set(agente).expect(200);
    expect(ficha.body.data.estado).toBe(ESTADO_ORDEN.ANULADA);
    expect(ficha.body.data.motivoAnulacion).toMatch(/desistio/);
  });
});

describe('conversion de ruta a taller', () => {
  it('conserva el numero y el historial, y no admite la vuelta', async () => {
    const base = await clienteConArticulo();
    const creada = await peticion(entorno.aplicacion).post(`${RAIZ}/ordenes`).set(agente)
      .send({
        idCliente: base.idCliente, idArticulo: base.idArticulo,
        modalidad: MODALIDAD_SERVICIO.RUTA, tipoGarantiaElegida: 'proveedor', fallaReportada: 'No enfria',
      }).expect(201);
    const idOrden = creada.body.data.id;
    const numeroOriginal = creada.body.data.numero;

    const idTec = await idTecnico('ruta');
    const tecnico = await sesionDelTecnico(idTec);
    await peticion(entorno.aplicacion).put(`${RAIZ}/ordenes/${idOrden}/tecnico`)
      .set(jefeTecnicos).send({ idTecnico: idTec }).expect(200);

    await cargarEvidenciaPendiente(idOrden, 'recepcion');
    await mover(agente, idOrden, ESTADO_ORDEN.ASIGNADA).expect(200);

    // Sin visita programada no sale a ruta.
    await cargarEvidenciaPendiente(idOrden, 'validacion_garantia');
    const sinVisita = await mover(jefeTecnicos, idOrden, ESTADO_ORDEN.EN_RUTA);
    expect(sinVisita.status).toBe(422);
    expect(sinVisita.body.error.message).toMatch(/visita programada/);

    await peticion(entorno.aplicacion).post(`${RAIZ}/ordenes/${idOrden}/visitas`)
      .set(jefeTecnicos)
      .send({ idTecnico: idTec, fechaProgramada: '2026-11-03', franjaHoraria: '09:00-11:00' })
      .expect(201);

    await mover(jefeTecnicos, idOrden, ESTADO_ORDEN.EN_RUTA).expect(200);

    // Conversion: se lleva el articulo al taller.
    const convertida = await mover(tecnico, idOrden, ESTADO_ORDEN.EN_COLA_TALLER);
    expect(convertida.status).toBe(200);
    expect(convertida.body.data.orden.numero).toBe(numeroOriginal);
    expect(convertida.body.data.orden.modalidad).toBe(MODALIDAD_SERVICIO.TALLER);

    const ficha = await peticion(entorno.aplicacion)
      .get(`${RAIZ}/ordenes/${idOrden}`).set(agente).expect(200);
    expect(ficha.body.data.numero).toBe(numeroOriginal);
    // El historial conserva el paso por ruta.
    const estados = ficha.body.data.eventos.map((e: { estadoNuevo: string }) => e.estadoNuevo);
    expect(estados).toContain(ESTADO_ORDEN.EN_RUTA);
    expect(estados).toContain(ESTADO_ORDEN.EN_COLA_TALLER);
    expect(ficha.body.data.eventos.at(-1).observacion).toMatch(/Conversion de ruta a taller/);

    // Y no hay vuelta atras.
    const vuelta = await mover(jefeTecnicos, idOrden, ESTADO_ORDEN.EN_RUTA);
    expect(vuelta.status).toBe(422);
    expect(vuelta.body.error.code).toBe('TRANSICION_INVALIDA');
    expect(ficha.body.data.destinosPosibles).not.toContain(ESTADO_ORDEN.EN_RUTA);
  });
});

describe('agenda: la doble programacion es imposible', () => {
  async function fechaSinVisitas(): Promise<string> {
    const { rows } = await entorno.piscina.query<{ fecha: string }>(
      "SELECT (GREATEST(CURRENT_DATE, MAX(fecha_programada)) + 1)::text AS fecha FROM visita",
    );
    return rows[0]!.fecha;
  }

  it('dos visitas del mismo tecnico en la misma franja: la segunda falla', async () => {
    // Prueba 2 del pliego.
    const primera = await crearOrden({ modalidad: MODALIDAD_SERVICIO.RUTA });
    const segunda = await crearOrden({ modalidad: MODALIDAD_SERVICIO.RUTA });
    const idTec = await idTecnico('ruta');
    const franja = { idTecnico: idTec, fechaProgramada: await fechaSinVisitas(), franjaHoraria: '13:00-15:00' };

    await peticion(entorno.aplicacion).post(`${RAIZ}/ordenes/${primera.id}/visitas`)
      .set(jefeTecnicos).send(franja).expect(201);

    const choque = await peticion(entorno.aplicacion).post(`${RAIZ}/ordenes/${segunda.id}/visitas`)
      .set(jefeTecnicos).send(franja);
    expect(choque.status).toBe(409);
    expect(choque.body.error.message).toMatch(/ya tiene una visita/);
    expect(choque.body.error.message).not.toMatch(/constraint|duplicate/i);

    // Otro tecnico en la misma franja si puede.
    const otroTecnico = await entorno.piscina.query<{ id: string }>(
      "SELECT id FROM tecnico WHERE tipo = 'ruta' AND id <> $1 LIMIT 1", [idTec],
    );
    await peticion(entorno.aplicacion).post(`${RAIZ}/ordenes/${segunda.id}/visitas`)
      .set(jefeTecnicos).send({ ...franja, idTecnico: otroTecnico.rows[0]!.id }).expect(201);
  });

  it('reprogramar libera la franja anterior', async () => {
    const orden = await crearOrden({ modalidad: MODALIDAD_SERVICIO.RUTA });
    const otra = await crearOrden({ modalidad: MODALIDAD_SERVICIO.RUTA });
    const idTec = await idTecnico('ruta');
    const franja = { idTecnico: idTec, fechaProgramada: await fechaSinVisitas(), franjaHoraria: '15:00-17:00' };

    await peticion(entorno.aplicacion).post(`${RAIZ}/ordenes/${orden.id}/visitas`)
      .set(jefeTecnicos).send(franja).expect(201);

    await peticion(entorno.aplicacion).put(`${RAIZ}/ordenes/${orden.id}/visitas`)
      .set(jefeTecnicos)
      .send({ ...franja, franjaHoraria: '17:00-19:00', motivo: 'El cliente pidio mas tarde' })
      .expect(200);

    // La franja original quedo libre para otra orden.
    await peticion(entorno.aplicacion).post(`${RAIZ}/ordenes/${otra.id}/visitas`)
      .set(jefeTecnicos).send(franja).expect(201);

    // Y la visita anterior sigue ahi, marcada como no vigente.
    const visitas = await peticion(entorno.aplicacion)
      .get(`${RAIZ}/ordenes/${orden.id}/visitas`).set(jefeTecnicos).expect(200);
    expect(visitas.body.data).toHaveLength(2);
    expect(visitas.body.data.filter((v: { vigente: boolean }) => v.vigente)).toHaveLength(1);
  });
});

describe('plazos y alertas', () => {
  it('el plazo se cuenta en horas laborables, no corridas', async () => {
    const creada = await crearOrden();
    const { rows } = await entorno.piscina.query<{ fecha_estado_desde: Date; plazo_vence_en: Date }>(
      'SELECT fecha_estado_desde, plazo_vence_en FROM orden_servicio WHERE id = $1', [creada.id],
    );
    const { rows: regla } = await entorno.piscina.query<{ horas_maximas: number }>(
      `SELECT horas_maximas FROM regla_plazo
        WHERE activa AND estado = 'registrada' AND tipo IS NULL LIMIT 1`,
    );

    const corridas = (rows[0]!.plazo_vence_en.getTime() - rows[0]!.fecha_estado_desde.getTime()) / 3_600_000;
    // El centro cierra de noche y los domingos, asi que el vencimiento cae
    // mas lejos en tiempo corrido que las horas laborables del plazo.
    expect(corridas).toBeGreaterThanOrEqual(regla[0]!.horas_maximas);
  });

  it('el panel de alertas devuelve solo lo vencido o por vencer', async () => {
    const respuesta = await peticion(entorno.aplicacion)
      .get(`${RAIZ}/ordenes/alertas?tamano=50`).set(jefeTecnicos).expect(200);

    expect(respuesta.body.data.length).toBeGreaterThan(0);
    for (const orden of respuesta.body.data) {
      expect(orden.vencida || orden.enAlerta).toBe(true);
      expect(['entregada', 'cerrada_sin_reparar', 'anulada']).not.toContain(orden.estado);
    }
  });

  it('la bandeja llega paginada y se puede filtrar por vencidas', async () => {
    const respuesta = await peticion(entorno.aplicacion)
      .get(`${RAIZ}/ordenes?soloVencidas=true&tamano=10`).set(jefeTecnicos).expect(200);

    expect(respuesta.body.data.length).toBeLessThanOrEqual(10);
    expect(respuesta.body.pagination.total).toBeGreaterThan(0);
    for (const orden of respuesta.body.data) expect(orden.vencida).toBe(true);
  });
});

describe('nota de correccion', () => {
  it('una orden cerrada no se edita: se le adjunta una nota', async () => {
    const creada = await crearOrden();
    await mover(jefatura, creada.id, ESTADO_ORDEN.ANULADA, {
      motivo: 'Orden duplicada: se atendio en la orden anterior',
    }).expect(200);

    // Ya no se puede mover.
    const intento = await mover(jefatura, creada.id, ESTADO_ORDEN.ASIGNADA);
    expect(intento.status).toBe(422);
    expect(intento.body.error.code).toBe('ORDEN_CERRADA');

    await peticion(entorno.aplicacion).post(`${RAIZ}/ordenes/${creada.id}/notas`).set(jefatura)
      .send({
        motivo: 'Se anulo por error de digitacion',
        detalle: 'La orden correcta es la 10345; esta se abrio dos veces por el mismo reporte.',
      }).expect(204);

    const ficha = await peticion(entorno.aplicacion)
      .get(`${RAIZ}/ordenes/${creada.id}`).set(agente).expect(200);
    expect(ficha.body.data.notas).toHaveLength(1);
    expect(ficha.body.data.notas[0].motivo).toMatch(/error de digitacion/);
  });

  it('una orden abierta se corrige, no se le adjunta nota', async () => {
    const creada = await crearOrden();
    const respuesta = await peticion(entorno.aplicacion)
      .post(`${RAIZ}/ordenes/${creada.id}/notas`).set(jefatura)
      .send({ motivo: 'Motivo cualquiera', detalle: 'Detalle cualquiera de la correccion' });

    expect(respuesta.status).toBe(422);
    expect(respuesta.body.error.code).toBe('ORDEN_ABIERTA');
  });

  it('solo quien tiene el permiso adjunta notas', async () => {
    const creada = await crearOrden();
    await mover(jefatura, creada.id, ESTADO_ORDEN.ANULADA, { motivo: 'Anulada para la prueba de permisos' })
      .expect(200);

    await peticion(entorno.aplicacion).post(`${RAIZ}/ordenes/${creada.id}/notas`).set(agente)
      .send({ motivo: 'Motivo cualquiera', detalle: 'Detalle cualquiera de la correccion' })
      .expect(403);
  });
});

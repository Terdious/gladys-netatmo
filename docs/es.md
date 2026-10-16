# Integración Netatmo para Gladys Assistant

Conecte sus dispositivos **Netatmo** — estación meteorológica, termostatos y
válvulas de radiador, cámaras de interior/exterior y sus accesorios, persianas
enrollables Bubendorff — a Gladys Assistant.

Esta integración se comunica con la nube de Netatmo en su nombre: usted crea una
sola vez su propia aplicación Netatmo Connect, conecta su cuenta, y Gladys
descubre sus dispositivos y mantiene sus valores actualizados.

---

## Requisitos previos

- Una **cuenta Netatmo**, con sus dispositivos ya instalados y funcionando en la
  aplicación Netatmo (Gladys lee lo que Netatmo expone — un dispositivo debe
  estar primero en línea en Netatmo).
- Gladys Assistant **4.86 o posterior**.

---

## Paso 1 — Cree su aplicación Netatmo Connect

Gladys nunca incluye una clave Netatmo compartida: usted utiliza **su propia**
aplicación Netatmo Connect, de modo que sus datos quedan entre su Gladys y su
cuenta Netatmo.

1. Vaya a **[Netatmo Connect](https://dev.netatmo.com/)** e inicie sesión con su
   cuenta Netatmo.
2. Abra **[My Apps → Create](https://dev.netatmo.com/apps/)** y cree una nueva
   aplicación (cualquier nombre y descripción — p. ej., "Gladys").
3. Una vez creada, la página de la aplicación muestra dos valores que deberá
   copiar en Gladys:
   - **client id** (ID de cliente)
   - **client secret** (secreto de cliente)

**No** necesita configurar permisos (scopes) ni una URI de redirección en el
portal: Gladys solicita automáticamente los permisos necesarios (lectura +
escritura, que cubren Energía, Meteorología, Seguridad, cámaras incluidas, y
las persianas enrollables) durante la conexión, y gestiona por sí mismo la redirección OAuth2.

---

## Paso 2 — Configure y conecte en Gladys

En la pestaña **Configuración** de la integración:

1. Pegue su **ID de cliente** y su **secreto de cliente**.
2. Haga clic en **Guardar configuración**.
3. Haga clic en **Conectar**: se abre una ventana de Netatmo; inicie sesión y
   autorice a Gladys. Se le redirige de vuelta y el estado pasa a **Conectado**.

> **Consejo:** haga clic siempre en **Guardar configuración** con el ID de
> cliente / secreto _antes_ de hacer clic en Conectar. Si Conectar indica que
> primero deben guardarse las credenciales, guarde el formulario y vuelva a
> hacer clic en Conectar.

Los tokens de acceso y de actualización los almacena la propia integración y
nunca aparecen en el formulario. Gladys los renueva automáticamente; si la
sesión llegara a expirar sin posibilidad de renovación, la pestaña Configuración
le indica que vuelva a conectarse.

---

## Paso 3 — Elija las familias de dispositivos

En **Dispositivos a descubrir**, active las familias que posee:

| Interruptor               | Descubre                                                                        |
| ------------------------- | ------------------------------------------------------------------------------- |
| **Energía**               | Termostato (`NATherm1`), relé (`NAPlug`), válvulas de radiador (`NRV`)          |
| **Meteorología**          | Estación (`NAMain`) + módulos exterior, viento, lluvia e interiores adicionales |
| **Seguridad**             | Cámaras de interior (`NACamera`) y de exterior (`NOC`), más sus accesorios      |
| **Persianas enrollables** | Persianas Bubendorff de una pasarela iDiamant (`NBR`, `NBO`, `NBS`)             |

Al activar una familia y **guardar**, el descubrimiento se vuelve a ejecutar
automáticamente — no hace falta volver a escanear manualmente. Los dispositivos
nuevos aparecen en la pestaña **Descubrir**, donde puede crear los que desee.

**Calidad de la transmisión en directo de las cámaras** (`poor` / `low` /
`medium` / `high`, por defecto `high`) define la calidad de la transmisión en
directo de las cámaras.

Los valores se actualizan cada **2 minutos** (límites de uso de la API de
Netatmo).

---

## Cámaras

Cuando la familia Seguridad está activada, cada cámara se crea con:

- una **imagen para el panel** (una captura, actualizada automáticamente) —
  Gladys la obtiene **primero desde la red local** (y, si no, desde la URL VPN
  de Netatmo);
- un interruptor de **vigilancia** (activar/desactivar la vigilancia de la
  cámara);
- un botón de **transmisión en directo** (HLS), construido también priorizando
  la red local.

### Transmisión en directo — latencia y audio

- **Latencia (~10 s):** es inherente a la transmisión HLS en directo de Netatmo
  — exactamente el mismo retraso existe en las propias aplicaciones web y móvil
  de Netatmo. Prefiera la latencia `low` en el recuadro de cámara del panel, y
  la calidad de cámara `medium` (720p) si desea una reproducción más fluida.
- **¿No hay sonido?** El micrófono de la cámara debe estar **activado** en la
  aplicación Netatmo: _Gestionar mi casa → seleccione la habitación de la cámara
  → Cámara → Ajustes avanzados → active el Micrófono_. Si allí está desactivado,
  ningún cliente (Gladys, web de Netatmo, aplicación Netatmo) recibe audio.
  Gladys transmite el audio siempre que la transmisión lo incluya — no hay nada
  que configurar del lado de Gladys.

---

## Webhooks de Gladys Plus (tiempo real) — opcional

Por defecto, Gladys consulta Netatmo **cada 2 minutos**. Con los webhooks,
Netatmo **avisa** a Gladys en cuanto ocurre algo: los valores se actualizan
entonces en **2-3 segundos** en lugar de esperar al siguiente ciclo — sin
aumentar el número de llamadas a la API de Netatmo.

Como un Gladys local no es accesible desde Internet, **Gladys Plus** retransmite
los eventos, por lo que se requiere una suscripción activa a Gladys Plus.

### Configuración (un solo paso)

1. En la pestaña **Configuración** de la integración, busque el bloque
   **"Webhooks de Gladys Plus"** (se muestra automáticamente).
2. Pegue allí su **clave de Open API** de Gladys Plus. Eso es todo.

**No hay nada que pegar en el sitio web de Netatmo:** la propia integración
registra la URL en Netatmo, y la vuelve a registrar en cada reconexión. Para
comprobarlo, abra la pestaña **Registros** de la integración: debería ver

```
Netatmo webhook registered — events will trigger an immediate refresh
```

Sin clave (o sin Gladys Plus), la integración se comporta exactamente como
antes, consultando cada 2 minutos.

### Qué aporta

- **Los valores llegan casi al instante** — por ejemplo, una consigna de
  termostato cambiada desde la aplicación Netatmo, o el estado de vigilancia de
  una cámara.
- **Detecciones que puede usar en sus escenas** (ver más abajo).

### Detecciones en tiempo real (disparadores de escena)

Algunos eventos son **momentáneos**: solo existen en el flujo de eventos, y
ninguna consulta a la API puede reportarlos. Se publican como funcionalidades
dedicadas, utilizables como **disparadores de escena**:

| Dispositivo                    | Funcionalidad          | Activada por                       |
| ------------------------------ | ---------------------- | ---------------------------------- |
| Cámaras de interior y exterior | **Movimiento**         | movimiento detectado               |
| Cámaras de interior y exterior | **Persona detectada**  | una persona detectada / reconocida |
| Cámara de exterior (Presence)  | **Animal detectado**   | un animal detectado                |
| Cámara de exterior (Presence)  | **Vehículo detectado** | un vehículo detectado              |
| Detector de humo               | **Humo**               | una detección de humo              |

Cada detección pasa a **Sí** y vuelve a **No** por sí sola al cabo de un minuto
(Netatmo no envía ningún evento de "fin de detección"). En una escena, utilice
el disparador "el valor pasa a Sí".

> ⚠️ **Si sus cámaras ya existían en Gladys**, estas nuevas funcionalidades no
> aparecen por sí solas: vaya a la pestaña **Descubrir** y haga clic en
> **Actualizar** en cada cámara (o detector de humo) para añadirlas. Sin webhooks
> configurados, estas funcionalidades simplemente permanecen en "No".

---

## Accesorios de seguridad (conectados a través de la cámara)

Cuando la familia Seguridad está activada, también se descubren los accesorios
vinculados a sus cámaras:

- **Sensor de puerta / ventana** (`NACamDoorTag`) — un sensor de apertura
  (abierto/cerrado), más la batería y la señal RF.
- **Sirena de interior** (`NIS`) — un sensor de sirena sonando, de solo lectura,
  más la batería y la señal RF.
- **Detector de humo** (`NSD`) — descubierto con su batería y su señal, más una
  funcionalidad **Humo** alimentada por los webhooks (ver la sección anterior):
  la consulta periódica por sí sola no puede reportar ese estado.

---

## Persianas enrollables (Bubendorff / iDiamant)

Active **Persianas enrollables (Bubendorff / iDiamant)** en **Dispositivos a
descubrir** (desactivado por defecto) para descubrir las persianas Bubendorff
conectadas a su pasarela iDiamant: modelos por radio (`NBR`), cableados
(`NBO`) y solares (`NBS`). Cada persiana se crea con:

- un control **abrir / cerrar / parar**;
- una **posición** (0 % = cerrada, 100 % = abierta), que también puede ajustar;
- la calidad de su **señal RF**.

La pasarela iDiamant no se crea como dispositivo: su identificador se guarda en
el parámetro `plug_id` de la persiana, y cada orden pasa por ella. Tras una
orden, Gladys actualiza los valores unos 30 segundos después para que la nueva
posición aparezca sin esperar al siguiente ciclo de 2 minutos.

> ⚠️ **¿Ya estaba conectado antes de la compatibilidad con las persianas?** Las
> persianas necesitan dos nuevos permisos de Netatmo. Vuelva a hacer clic en
> **Conectar** en la pantalla de configuración y autorice a Gladys — sus
> dispositivos y ajustes se conservan. Hasta entonces, una orden de persiana
> falla y la pantalla de configuración le pide que vuelva a conectarse.

**Posiciones intermedias:** según el modelo y el motor, algunas persianas
Bubendorff solo se abren o se cierran por completo. Una posición intermedia
puede entonces ser ignorada o redondeada por la persiana, y la posición
reportada puede reflejar solo la última orden — use abrir / cerrar / parar en
esos modelos.

---

## Actualizar la integración

**Instalada desde el catálogo** (el caso habitual): Gladys consulta el store
con regularidad. Cuando sale una nueva versión, la integración muestra la
insignia **"Actualización disponible"** (también contada junto a
**Integraciones** en el menú), y su pestaña **Supervisión** indica la versión
ofrecida, con un enlace a sus notas de versión. Haga clic en **Actualizar**:
Gladys descarga la nueva imagen **y** aplica el nuevo manifiesto — los nuevos
campos de configuración aparecen solos, no hay nada que volver a pegar. Su
configuración y sus dispositivos se conservan.

Gladys puede tardar hasta una hora y media aproximadamente en detectar una
nueva versión (actualización del índice del store). **"Forzar actualización"**
lo comprueba de inmediato: lee la última versión publicada y descarga su
imagen.

**Instalada en modo desarrollador** (manifiesto pegado a mano): **"Forzar
actualización"** solo vuelve a descargar la imagen de la etiqueta instalada, y
la versión mostrada y los campos de configuración provienen del manifiesto
pegado — vuelva a pegar el manifiesto actualizado para obtener los nuevos
campos.

---

## Migrar desde el servicio Netatmo integrado

Esta integración externa sustituye al servicio Netatmo integrado en Gladys. Sus
dispositivos tienen nuevos identificadores (`netatmo:*` → `ext:netatmo:*`), por
lo que se crean como dispositivos nuevos — pero desde **Gladys 4.84.1** puede
**migrar** cada dispositivo antiguo a su sustituto y conservar su **historial de
estados**, sus **escenas** y sus **paneles**.

### Antes de empezar

- **No elimine sus antiguos dispositivos Netatmo**: la migración parte de ellos.
- **Migre poco después de crear los nuevos dispositivos.** Si ambos
  dispositivos registraron valores durante el mismo periodo, solo se mueve el
  historial antiguo _anterior al primer valor del nuevo dispositivo_, para no
  contar nada dos veces: los valores del dispositivo antiguo en el periodo
  común se descartan.

### Pasos

1. Instale y conecte esta integración y luego cree sus dispositivos desde la
   pestaña **Descubrir**: el destino debe existir antes de migrar.
2. Abra **Integraciones → Netatmo** — la integración integrada, marcada como
   obsoleta — y luego su pestaña **Dispositivos**.
3. En un dispositivo antiguo, haga clic en **Migrar**.
4. Elija el **Dispositivo de destino**: el nuevo dispositivo, listado bajo la
   integración externa Netatmo (la lista se puede filtrar por integración,
   habitación y nombre).
5. Revise la tabla **Coincidencia de funciones**. Gladys la rellena de antemano
   (misma categoría, mismo tipo y misma unidad, y luego mismo nombre para
   distinguir las gemelas); cada función antigua puede asociarse a mano o
   marcarse como **No migrar** — su historial se elimina entonces. Revise bien
   las filas de temperatura de los termostatos y las estaciones, que tienen
   varias funciones de temperatura.
6. Haga clic en **Migrar y eliminar el dispositivo antiguo**.

Gladys mueve el historial, reescribe las escenas y los paneles que usaban el
dispositivo antiguo, coloca el nuevo dispositivo en la habitación del antiguo
si no tiene ninguna, vuelve a enlazar los vínculos de energía y luego elimina
el dispositivo antiguo. El resultado indica el número de estados movidos y de
escenas / paneles actualizados. Repita para cada dispositivo.

Un historial largo puede tardar varios minutos: sígalo en **Configuración →
Tareas**. Si la página pierde la conexión, la migración sigue en segundo plano
— revise esa página antes de volver a intentarlo. Una migración fallida puede
relanzarse: solo mueve lo que queda.

---

## Solución de problemas

- **"Guarde primero" al conectar:** guarde el ID de cliente / secreto y luego
  vuelva a hacer clic en Conectar.
- **Sesión expirada:** vuelva a hacer clic en Conectar para volver a autorizar
  su cuenta Netatmo.
- **Un dispositivo muestra una insignia "inaccesible":** Netatmo lo reporta como
  desconectado (batería agotada, apagado, fuera de alcance). Gladys deja de
  publicar sus últimos valores conocidos para que no le induzcan a error datos
  obsoletos; la insignia desaparece cuando el dispositivo vuelve.
- **Un valor de cámara o un comando de vigilancia falla una vez con un mensaje
  de "reconectar":** a su autorización Netatmo le falta el permiso de cámara —
  vuelva a conectar su cuenta.
- **Una orden de persiana falla con un mensaje de "reconectar":** su
  autorización Netatmo es anterior a la compatibilidad con las persianas —
  vuelva a hacer clic en Conectar.
- **No hay sonido en la cámara:** consulte el consejo sobre el micrófono en la
  sección Cámaras más arriba.

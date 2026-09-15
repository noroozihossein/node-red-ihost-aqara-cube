'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

module.exports = function(RED) {

    function normalizeHost(host) {
        host = String(host || '').trim();
        if (!host) return '';
        if (!/^https?:\/\//i.test(host)) {
            host = 'http://' + host;
        }
        return host.replace(/\/$/, '');
    }

    function requestJson(method, fullUrl, token, body) {
        return new Promise((resolve, reject) => {
            let u;

            try {
                u = new URL(fullUrl);
            } catch (e) {
                return reject(e);
            }

            const lib = u.protocol === 'https:' ? https : http;
            const data =
                body === undefined
                    ? null
                    : Buffer.from(JSON.stringify(body));

            const headers = {
                'Content-Type': 'application/json'
            };

            if (token) {
                headers.Authorization = `Bearer ${token}`;
            }

            if (data) {
                headers['Content-Length'] = data.length;
            }

            const req = lib.request({
                protocol: u.protocol,
                hostname: u.hostname,
                port: u.port || (u.protocol === 'https:' ? 443 : 80),
                path: u.pathname + u.search,
                method,
                headers,
                timeout: 8000
            }, res => {
                let raw = '';

                res.setEncoding('utf8');

                res.on('data', chunk => {
                    raw += chunk;
                });

                res.on('end', () => {
                    let parsed = {};

                    try {
                        parsed = raw ? JSON.parse(raw) : {};
                    } catch (e) {
                        return reject(
                            new Error(
                                `Invalid JSON response (${res.statusCode})`
                            )
                        );
                    }

                    if (
                        res.statusCode >= 400 ||
                        (
                            parsed &&
                            parsed.error &&
                            parsed.error !== 0
                        )
                    ) {
                        return reject(
                            new Error(
                                parsed.message ||
                                `HTTP ${res.statusCode}`
                            )
                        );
                    }

                    resolve(parsed);
                });
            });

            req.on('timeout', () => {
                req.destroy(
                    new Error('Request timeout')
                );
            });

            req.on('error', reject);

            if (data) {
                req.write(data);
            }

            req.end();
        });
    }

    /*
     * ---------------------------------------------------------
     * iHost config node
     * ---------------------------------------------------------
     *
     * This uses a unique config-node type so it can coexist
     * with the existing Mr Smart Rotary package.
     */

    function IHostCubeConfigNode(config) {
        RED.nodes.createNode(this, config);

        const node = this;

        node.name =
            config.name ||
            'iHost';

        node.host =
            normalizeHost(config.host);

        node.token =
            node.credentials &&
            node.credentials.token
                ? node.credentials.token
                : '';

        node.deviceMap =
            new Map();

        node.subscribers =
            new Set();

        node.sseReq =
            null;

        node.reconnectTimer =
            null;

        node.closed =
            false;

        node.refreshDevices =
            async function() {

                if (
                    !node.host ||
                    !node.token
                ) {
                    throw new Error(
                        'iHost host/token not configured'
                    );
                }

                const result =
                    await requestJson(
                        'GET',
                        `${node.host}/open-api/v2/rest/devices`,
                        node.token
                    );

                const list =
                    (
                        result.data &&
                        result.data.device_list
                    ) ||
                    [];

                list.forEach(device => {
                    node.deviceMap.set(
                        device.serial_number,
                        device
                    );
                });

                return list;
            };

        node.putDeviceState =
            async function(serial, state) {

                return requestJson(
                    'PUT',
                    `${node.host}/open-api/v2/rest/devices/${encodeURIComponent(serial)}`,
                    node.token,
                    { state }
                );
            };

        node.subscribe =
            function(fn) {

                node.subscribers.add(fn);

                return () => {
                    node.subscribers.delete(fn);
                };
            };

        node.emitEvent =
            function(type, data) {

                if (
                    type ===
                        'device#v2#updateDeviceState' &&
                    data &&
                    data.endpoint &&
                    data.endpoint.serial_number
                ) {
                    const serial =
                        data.endpoint.serial_number;

                    const existing =
                        node.deviceMap.get(serial) ||
                        {
                            serial_number: serial,
                            state: {}
                        };

                    existing.state =
                        Object.assign(
                            {},
                            existing.state || {},
                            data.payload || {}
                        );

                    node.deviceMap.set(
                        serial,
                        existing
                    );
                }

                for (
                    const fn
                    of node.subscribers
                ) {
                    try {
                        fn(type, data);
                    } catch (e) {
                        node.warn(e.message);
                    }
                }
            };

        function scheduleReconnect() {
            if (
                node.closed ||
                node.reconnectTimer
            ) {
                return;
            }

            node.reconnectTimer =
                setTimeout(() => {
                    node.reconnectTimer =
                        null;

                    node.startSSE();
                }, 3000);
        }

        node.startSSE =
            function() {

                if (
                    node.closed ||
                    node.sseReq ||
                    !node.host ||
                    !node.token
                ) {
                    return;
                }

                let u;

                try {
                    u = new URL(
                        `${node.host}/open-api/v2/sse/bridge?access_token=${encodeURIComponent(node.token)}`
                    );
                } catch (e) {
                    node.error(e.message);
                    return;
                }

                const lib =
                    u.protocol === 'https:'
                        ? https
                        : http;

                const req =
                    lib.request({
                        protocol: u.protocol,
                        hostname: u.hostname,
                        port:
                            u.port ||
                            (
                                u.protocol ===
                                'https:'
                                    ? 443
                                    : 80
                            ),
                        path:
                            u.pathname +
                            u.search,
                        method: 'GET',
                        headers: {
                            Accept:
                                'text/event-stream',
                            'Cache-Control':
                                'no-cache'
                        }
                    }, res => {

                        if (
                            res.statusCode !== 200
                        ) {
                            res.resume();

                            node.sseReq =
                                null;

                            return scheduleReconnect();
                        }

                        res.setEncoding(
                            'utf8'
                        );

                        let buffer = '';

                        res.on(
                            'data',
                            chunk => {

                                buffer +=
                                    chunk.replace(
                                        /\r\n/g,
                                        '\n'
                                    );

                                let idx;

                                while (
                                    (
                                        idx =
                                            buffer.indexOf(
                                                '\n\n'
                                            )
                                    ) >= 0
                                ) {
                                    const block =
                                        buffer.slice(
                                            0,
                                            idx
                                        );

                                    buffer =
                                        buffer.slice(
                                            idx + 2
                                        );

                                    let eventName =
                                        'message';

                                    const dataLines =
                                        [];

                                    for (
                                        const line
                                        of block.split(
                                            '\n'
                                        )
                                    ) {
                                        if (
                                            line.startsWith(
                                                'event:'
                                            )
                                        ) {
                                            eventName =
                                                line.slice(
                                                    6
                                                ).trim();
                                        } else if (
                                            line.startsWith(
                                                'data:'
                                            )
                                        ) {
                                            dataLines.push(
                                                line.slice(
                                                    5
                                                ).trimStart()
                                            );
                                        }
                                    }

                                    if (
                                        !dataLines.length
                                    ) {
                                        continue;
                                    }

                                    const raw =
                                        dataLines.join(
                                            '\n'
                                        );

                                    try {
                                        node.emitEvent(
                                            eventName,
                                            JSON.parse(raw)
                                        );
                                    } catch (e) {
                                        /*
                                         * Keepalive or non-JSON.
                                         */
                                    }
                                }
                            }
                        );

                        res.on(
                            'end',
                            () => {
                                node.sseReq =
                                    null;

                                scheduleReconnect();
                            }
                        );

                        res.on(
                            'error',
                            () => {
                                node.sseReq =
                                    null;

                                scheduleReconnect();
                            }
                        );
                    });

                req.on(
                    'error',
                    () => {
                        node.sseReq =
                            null;

                        scheduleReconnect();
                    }
                );

                req.end();

                node.sseReq =
                    req;
            };

        if (
            node.host &&
            node.token
        ) {
            /*
             * Populate full REST catalogue first so target
             * capability detection is available before SSE
             * starts delivering partial state events.
             */
            node.refreshDevices()
                .catch(() => {})
                .finally(
                    () => node.startSSE()
                );
        }

        node.on(
            'close',
            function(done) {

                node.closed =
                    true;

                if (
                    node.reconnectTimer
                ) {
                    clearTimeout(
                        node.reconnectTimer
                    );
                }

                if (
                    node.sseReq
                ) {
                    try {
                        node.sseReq.destroy();
                    } catch (e) {}
                }

                node.subscribers.clear();

                done();
            }
        );
    }

    RED.nodes.registerType(
        'mrsmart-cube-ihost-config',
        IHostCubeConfigNode,
        {
            credentials: {
                token: {
                    type: 'password'
                }
            }
        }
    );

    /*
     * ---------------------------------------------------------
     * Aqara Cube controller node
     * ---------------------------------------------------------
     */

    function AqaraCubeNode(config) {
        RED.nodes.createNode(
            this,
            config
        );

        const node =
            this;

        node.server =
            RED.nodes.getNode(
                config.server
            );

        node.cubeSerial =
            config.cubeSerial ||
            '';

        /*
         * Multi-target support.
         */
        let targets = [];

        if (
            Array.isArray(
                config.targetSerials
            )
        ) {
            targets =
                config.targetSerials;
        } else if (
            typeof
                config.targetSerials ===
                'string' &&
            config.targetSerials.trim()
        ) {
            try {
                const parsed =
                    JSON.parse(
                        config.targetSerials
                    );

                targets =
                    Array.isArray(parsed)
                        ? parsed
                        : [
                            config.targetSerials
                        ];
            } catch (e) {
                targets =
                    [
                        config.targetSerials
                    ];
            }
        }

        if (
            !targets.length &&
            config.targetSerial
        ) {
            targets =
                [
                    config.targetSerial
                ];
        }

        node.targetSerials =
            [
                ...new Set(
                    targets.filter(
                        Boolean
                    )
                )
            ];

        node.groupMode =
            config.groupMode ||
            'synchronized';

        node.brightnessStep =
            Math.max(
                1,
                Math.min(
                    10,
                    Number(
                        config.brightnessStep ||
                        3
                    )
                )
            );

        node.cctStep =
            Math.max(
                1,
                Math.min(
                    30,
                    Number(
                        config.cctStep ||
                        15
                    )
                )
            );

        /*
         * Installer-selectable temporary CCT modifier.
         *
         * Supported examples:
         * shake
         * slide
         * tap
         * flip90
         * flip180
         * throw
         * fall
         * wakeup
         * disabled
         */
        node.cctModifierGesture =
            config.cctModifierGesture ||
            'shake';

        node.cctModeTimeout =
            Math.max(
                1,
                Math.min(
                    60,
                    Number(
                        config.cctModeTimeout ||
                        5
                    )
                )
            );

        /*
         * Gesture action mappings.
         *
         * Default behaviour:
         * tap = toggle
         * rotate = brightness
         * selected CCT modifier = enter temporary CCT mode
         *
         * Other actions can be configured later by the editor UI.
         */
        node.gestureActions = {
            shake:
                config.shakeAction ||
                'none',

            throw:
                config.throwAction ||
                'none',

            wakeup:
                config.wakeupAction ||
                'none',

            fall:
                config.fallAction ||
                'none',

            tap:
                config.tapAction ||
                'toggle',

            slide:
                config.slideAction ||
                'none',

            flip180:
                config.flip180Action ||
                'none',

            flip90:
                config.flip90Action ||
                'none'
        };

        node.unsub =
            null;

        node.actionQueue =
            Promise.resolve();

        /*
         * Temporary CCT mode state.
         */
        node.cctModeActive =
            false;

        node.cctModeTimer =
            null;

        /*
         * Per-target caches.
         *
         * These are required because some third-party Zigbee
         * controllers acknowledge writes but report stale or
         * incomplete state/capabilities through REST.
         */
        node.lastBrightness =
            new Map();

        node.lastCct =
            new Map();

        node.lastPower =
            new Map();

        if (
            !node.server
        ) {
            node.status({
                fill: 'red',
                shape: 'ring',
                text:
                    'iHost not configured'
            });

            return;
        }

        if (
            !node.cubeSerial
        ) {
            node.status({
                fill: 'red',
                shape: 'ring',
                text:
                    'select Aqara Cube'
            });

            return;
        }

        if (
            !node.targetSerials.length
        ) {
            node.status({
                fill: 'red',
                shape: 'ring',
                text:
                    'select target light(s)'
            });

            return;
        }

        function clamp(
            value,
            min,
            max
        ) {
            return Math.min(
                max,
                Math.max(
                    min,
                    value
                )
            );
        }

        function finiteOr(
            value,
            fallback
        ) {
            const n =
                Number(value);

            return Number.isFinite(n)
                ? n
                : fallback;
        }

        function mean(
            values,
            fallback
        ) {
            const valid =
                values.filter(
                    Number.isFinite
                );

            if (
                !valid.length
            ) {
                return fallback;
            }

            return (
                valid.reduce(
                    (a, b) =>
                        a + b,
                    0
                ) /
                valid.length
            );
        }

        function capabilitiesFor(
            device
        ) {
            return new Set(
                (
                    device &&
                    device.capabilities
                        ? device.capabilities
                        : []
                ).map(
                    c =>
                        c.capability
                )
            );
        }

        function readBrightness(
            state,
            fallback
        ) {
            if (
                !state
            ) {
                return fallback;
            }

            const raw =
                state.brightness;

            if (
                raw &&
                typeof raw ===
                    'object'
            ) {
                if (
                    raw.brightness !==
                    undefined
                ) {
                    return finiteOr(
                        raw.brightness,
                        fallback
                    );
                }

                if (
                    raw.value !==
                    undefined
                ) {
                    return finiteOr(
                        raw.value,
                        fallback
                    );
                }
            }

            if (
                raw !== undefined &&
                typeof raw !==
                    'object'
            ) {
                return finiteOr(
                    raw,
                    fallback
                );
            }

            return fallback;
        }

        function readCct(
            state,
            fallback
        ) {
            if (
                !state
            ) {
                return fallback;
            }

            const raw =
                state[
                    'color-temperature'
                ];

            if (
                raw &&
                typeof raw ===
                    'object'
            ) {
                if (
                    raw.colorTemperature !==
                    undefined
                ) {
                    return finiteOr(
                        raw.colorTemperature,
                        fallback
                    );
                }

                if (
                    raw.value !==
                    undefined
                ) {
                    return finiteOr(
                        raw.value,
                        fallback
                    );
                }
            }

            if (
                raw !== undefined &&
                typeof raw !==
                    'object'
            ) {
                return finiteOr(
                    raw,
                    fallback
                );
            }

            return fallback;
        }

        function targetInfo(
            serial
        ) {
            const dev =
                node.server.deviceMap.get(
                    serial
                ) ||
                {};

            const caps =
                capabilitiesFor(
                    dev
                );

            const state =
                dev.state ||
                {};

            const info = {
                serial,
                dev,
                state,

                hasPower:
                    caps.has(
                        'power'
                    ) ||
                    !!state.power,

                hasBrightness:
                    caps.has(
                        'brightness'
                    ) ||
                    !!state.brightness,

                hasCct:
                    caps.has(
                        'color-temperature'
                    ) ||
                    !!state[
                        'color-temperature'
                    ]
            };

            /*
             * Seed local state cache only if we do not
             * already hold a newer value.
             */
            const brightness =
                readBrightness(
                    state,
                    NaN
                );

            if (
                !node.lastBrightness.has(
                    serial
                ) &&
                Number.isFinite(
                    brightness
                )
            ) {
                node.lastBrightness.set(
                    serial,
                    brightness
                );
            }

            const cct =
                readCct(
                    state,
                    NaN
                );

            if (
                !node.lastCct.has(
                    serial
                ) &&
                Number.isFinite(
                    cct
                )
            ) {
                node.lastCct.set(
                    serial,
                    cct
                );
            }

            if (
                !node.lastPower.has(
                    serial
                ) &&
                state.power &&
                state.power.powerState
            ) {
                node.lastPower.set(
                    serial,
                    state.power.powerState
                );
            }

            return info;
        }

        async function ensureDevices() {
            const required =
                [
                    node.cubeSerial
                ].concat(
                    node.targetSerials
                );

            const needsRefresh =
                required.some(
                    serial => {
                        const dev =
                            node.server
                                .deviceMap
                                .get(
                                    serial
                                );

                        return (
                            !dev ||
                            !Array.isArray(
                                dev.capabilities
                            )
                        );
                    }
                );

            if (
                needsRefresh
            ) {
                await node.server
                    .refreshDevices();
            }
        }

        function getCubeGesture(
            data
        ) {
            return (
                data &&
                data.payload &&
                data.payload.press &&
                data.payload.press.press
            );
        }

        /*
         * -----------------------------------------------------
         * Temporary CCT Mode
         * -----------------------------------------------------
         */

        function clearCctTimer() {
            if (
                node.cctModeTimer
            ) {
                clearTimeout(
                    node.cctModeTimer
                );

                node.cctModeTimer =
                    null;
            }
        }

        function exitCctMode() {
            clearCctTimer();

            node.cctModeActive =
                false;

            node.status({
                fill: 'green',
                shape: 'dot',
                text:
                    `ready • ${node.targetSerials.length} targets`
            });
        }

        function resetCctTimer() {
            clearCctTimer();

            if (
                !node.cctModeActive
            ) {
                return;
            }

            node.cctModeTimer =
                setTimeout(
                    () => {
                        exitCctMode();
                    },
                    node.cctModeTimeout *
                    1000
                );
        }

        function enterCctMode() {
            node.cctModeActive =
                true;

            resetCctTimer();

            node.status({
                fill: 'blue',
                shape: 'dot',
                text:
                    `CCT mode • ${node.cctModeTimeout}s`
            });
        }

        /*
         * -----------------------------------------------------
         * Command generation
         * -----------------------------------------------------
         */

        function makePowerCommands(
            action,
            infos
        ) {
            const commands =
                [];

            const capable =
                infos.filter(
                    info =>
                        info.hasPower
                );

            if (
                !capable.length
            ) {
                return commands;
            }

            if (
                action === 'on'
            ) {
                capable.forEach(
                    info => {
                        commands.push({
                            serial:
                                info.serial,

                            state: {
                                power: {
                                    powerState:
                                        'on'
                                }
                            }
                        });
                    }
                );

                return commands;
            }

            if (
                action === 'off'
            ) {
                capable.forEach(
                    info => {
                        commands.push({
                            serial:
                                info.serial,

                            state: {
                                power: {
                                    powerState:
                                        'off'
                                }
                            }
                        });
                    }
                );

                return commands;
            }

            if (
                action !== 'toggle'
            ) {
                return commands;
            }

            const relative =
                node.groupMode ===
                'relative';

            if (
                relative
            ) {
                capable.forEach(
                    info => {

                        const reported =
                            info.state.power &&
                            info.state.power
                                .powerState;

                        const current =
                            node.lastPower.get(
                                info.serial
                            ) ||
                            reported ||
                            'off';

                        commands.push({
                            serial:
                                info.serial,

                            state: {
                                power: {
                                    powerState:
                                        current ===
                                        'on'
                                            ? 'off'
                                            : 'on'
                                }
                            }
                        });
                    }
                );
            } else {
                const anyOn =
                    capable.some(
                        info =>
                            info.state.power &&
                            info.state.power
                                .powerState ===
                                'on'
                    );

                const next =
                    anyOn
                        ? 'off'
                        : 'on';

                capable.forEach(
                    info => {
                        commands.push({
                            serial:
                                info.serial,

                            state: {
                                power: {
                                    powerState:
                                        next
                                }
                            }
                        });
                    }
                );
            }

            return commands;
        }

        function makeBrightnessCommands(
            direction,
            infos
        ) {
            const commands =
                [];

            /*
             * Selected lighting targets are controlled
             * optimistically for brightness, matching the
             * proven Rotary implementation.
             */
            const capable =
                infos;

            if (
                !capable.length
            ) {
                return commands;
            }

            const delta =
                direction === 'up'
                    ? node.brightnessStep
                    : -node.brightnessStep;

            const relative =
                node.groupMode ===
                'relative';

            if (
                relative
            ) {
                capable.forEach(
                    info => {

                        const current =
                            node.lastBrightness.has(
                                info.serial
                            )
                                ? node.lastBrightness.get(
                                    info.serial
                                )
                                : readBrightness(
                                    info.state,
                                    50
                                );

                        const value =
                            clamp(
                                current +
                                delta,
                                1,
                                100
                            );

                        commands.push({
                            serial:
                                info.serial,

                            state: {
                                brightness: {
                                    brightness:
                                        value
                                }
                            }
                        });
                    }
                );
            } else {
                const currentValues =
                    capable.map(
                        info =>
                            readBrightness(
                                info.state,
                                node.lastBrightness.has(
                                    info.serial
                                )
                                    ? node.lastBrightness.get(
                                        info.serial
                                    )
                                    : NaN
                            )
                    );

                const reference =
                    mean(
                        currentValues,
                        50
                    );

                const value =
                    clamp(
                        reference +
                        delta,
                        1,
                        100
                    );

                capable.forEach(
                    info => {
                        commands.push({
                            serial:
                                info.serial,

                            state: {
                                brightness: {
                                    brightness:
                                        value
                                }
                            }
                        });
                    }
                );
            }

            return commands;
        }

        function makeCctCommands(
            direction,
            infos
        ) {
            const commands =
                [];

            /*
             * CCT target eligibility:
             * capability or previously observed valid CCT.
             */
            const capable =
                infos.filter(
                    info =>
                        info.hasCct ||
                        node.lastCct.has(
                            info.serial
                        )
                );

            if (
                !capable.length
            ) {
                return commands;
            }

            const delta =
                direction === 'cooler'
                    ? node.cctStep
                    : -node.cctStep;

            const relative =
                node.groupMode ===
                'relative';

            if (
                relative
            ) {
                capable.forEach(
                    info => {

                        const current =
                            node.lastCct.has(
                                info.serial
                            )
                                ? node.lastCct.get(
                                    info.serial
                                )
                                : readCct(
                                    info.state,
                                    50
                                );

                        const value =
                            clamp(
                                current +
                                delta,
                                0,
                                100
                            );

                        commands.push({
                            serial:
                                info.serial,

                            state: {
                                'color-temperature': {
                                    colorTemperature:
                                        value
                                }
                            }
                        });
                    }
                );
            } else {
                const currentValues =
                    capable.map(
                        info =>
                            readCct(
                                info.state,
                                node.lastCct.has(
                                    info.serial
                                )
                                    ? node.lastCct.get(
                                        info.serial
                                    )
                                    : NaN
                            )
                    );

                const reference =
                    mean(
                        currentValues,
                        50
                    );

                const value =
                    clamp(
                        reference +
                        delta,
                        0,
                        100
                    );

                capable.forEach(
                    info => {
                        commands.push({
                            serial:
                                info.serial,

                            state: {
                                'color-temperature': {
                                    colorTemperature:
                                        value
                                }
                            }
                        });
                    }
                );
            }

            return commands;
        }

        /*
         * -----------------------------------------------------
         * Command execution
         * -----------------------------------------------------
         */

        async function applyCommands(
            action,
            commands
        ) {
            if (
                !commands.length
            ) {
                return;
            }

            node.status({
                fill: 'blue',
                shape: 'dot',
                text:
                    `${action} → ${commands.length}`
            });

            const settled =
                await Promise.allSettled(
                    commands.map(
                        command =>
                            node.server
                                .putDeviceState(
                                    command.serial,
                                    command.state
                                )
                    )
                );

            const succeeded =
                [];

            const failed =
                [];

            settled.forEach(
                (result, index) => {

                    const command =
                        commands[index];

                    if (
                        result.status ===
                        'fulfilled'
                    ) {
                        succeeded.push(
                            command.serial
                        );

                        const current =
                            node.server
                                .deviceMap
                                .get(
                                    command.serial
                                ) ||
                            {
                                serial_number:
                                    command.serial,
                                state: {}
                            };

                        current.state =
                            Object.assign(
                                {},
                                current.state ||
                                    {},
                                command.state
                            );

                        node.server
                            .deviceMap
                            .set(
                                command.serial,
                                current
                            );

                        if (
                            command.state
                                .brightness &&
                            command.state
                                .brightness
                                .brightness !==
                                undefined
                        ) {
                            node.lastBrightness.set(
                                command.serial,
                                Number(
                                    command.state
                                        .brightness
                                        .brightness
                                )
                            );
                        }

                        if (
                            command.state[
                                'color-temperature'
                            ] &&
                            command.state[
                                'color-temperature'
                            ]
                                .colorTemperature !==
                                undefined
                        ) {
                            node.lastCct.set(
                                command.serial,
                                Number(
                                    command.state[
                                        'color-temperature'
                                    ]
                                        .colorTemperature
                                )
                            );
                        }

                        if (
                            command.state
                                .power &&
                            command.state
                                .power
                                .powerState
                        ) {
                            node.lastPower.set(
                                command.serial,
                                command.state
                                    .power
                                    .powerState
                            );
                        }
                    } else {
                        failed.push({
                            serial:
                                command.serial,

                            error:
                                result.reason &&
                                result.reason
                                    .message
                                    ? result.reason
                                        .message
                                    : 'failed'
                        });
                    }
                }
            );

            if (
                failed.length
            ) {
                node.status({
                    fill: 'yellow',
                    shape: 'ring',
                    text:
                        `${succeeded.length}/${commands.length} targets updated`
                });
            } else if (
                node.cctModeActive
            ) {
                node.status({
                    fill: 'blue',
                    shape: 'dot',
                    text:
                        `CCT mode • ${node.cctModeTimeout}s`
                });
            } else {
                node.status({
                    fill: 'green',
                    shape: 'dot',
                    text:
                        `ready • ${commands.length} targets`
                });
            }

            node.send({
                topic:
                    'mrsmart/aqara-cube',

                action,

                cctMode:
                    node.cctModeActive,

                groupMode:
                    node.groupMode,

                targets:
                    commands.map(
                        command =>
                            command.serial
                    ),

                succeeded,

                failed,

                payload:
                    commands
            });
        }

        async function performConfiguredAction(
            action,
            infos
        ) {
            if (
                !action ||
                action === 'none'
            ) {
                return;
            }

            if (
                action === 'toggle' ||
                action === 'on' ||
                action === 'off'
            ) {
                await applyCommands(
                    action,
                    makePowerCommands(
                        action,
                        infos
                    )
                );

                return;
            }

            if (
                action === 'brightness_up'
            ) {
                await applyCommands(
                    action,
                    makeBrightnessCommands(
                        'up',
                        infos
                    )
                );

                return;
            }

            if (
                action === 'brightness_down'
            ) {
                await applyCommands(
                    action,
                    makeBrightnessCommands(
                        'down',
                        infos
                    )
                );

                return;
            }

            if (
                action === 'cct_cooler'
            ) {
                await applyCommands(
                    action,
                    makeCctCommands(
                        'cooler',
                        infos
                    )
                );

                return;
            }

            if (
                action === 'cct_warmer'
            ) {
                await applyCommands(
                    action,
                    makeCctCommands(
                        'warmer',
                        infos
                    )
                );

                return;
            }
        }

        /*
         * -----------------------------------------------------
         * Event processing
         * -----------------------------------------------------
         */

        async function processAction(
            type,
            data
        ) {
            if (
                type !==
                'device#v2#updateDeviceState'
            ) {
                return;
            }

            if (
                !data ||
                !data.endpoint ||
                !data.endpoint.serial_number
            ) {
                return;
            }

            const eventSerial =
                data.endpoint.serial_number;

            /*
             * Learn real target state changes caused by
             * iHost UI, eWeLink, scenes or other controllers.
             */
            if (
                node.targetSerials.includes(
                    eventSerial
                )
            ) {
                const payload =
                    data.payload ||
                    {};

                const brightness =
                    readBrightness(
                        payload,
                        NaN
                    );

                if (
                    Number.isFinite(
                        brightness
                    )
                ) {
                    node.lastBrightness.set(
                        eventSerial,
                        brightness
                    );
                }

                const cct =
                    readCct(
                        payload,
                        NaN
                    );

                if (
                    Number.isFinite(
                        cct
                    )
                ) {
                    node.lastCct.set(
                        eventSerial,
                        cct
                    );
                }

                if (
                    payload.power &&
                    payload.power
                        .powerState
                ) {
                    node.lastPower.set(
                        eventSerial,
                        payload.power
                            .powerState
                    );
                }

                return;
            }

            /*
             * Ignore events that are not from the selected Cube.
             */
            if (
                eventSerial !==
                node.cubeSerial
            ) {
                return;
            }

            const gesture =
                getCubeGesture(
                    data
                );

            if (
                !gesture
            ) {
                return;
            }

            /*
             * Ignore iHost's wakeup event as a control action
             * unless the installer explicitly maps it.
             */

            await ensureDevices();

            const infos =
                node.targetSerials.map(
                    targetInfo
                );

            /*
             * CCT Modifier
             *
             * The selected modifier gesture is reserved only
             * for entering temporary CCT mode. It does not also
             * execute its normal gesture action.
             */
            if (
                node.cctModifierGesture &&
                node.cctModifierGesture !==
                    'disabled' &&
                gesture ===
                    node.cctModifierGesture
            ) {
                enterCctMode();

                node.send({
                    topic:
                        'mrsmart/aqara-cube',

                    action:
                        'cct_mode_enter',

                    gesture,

                    cctMode:
                        true,

                    groupMode:
                        node.groupMode,

                    targets:
                        node.targetSerials.slice(),

                    payload: []
                });

                return;
            }

            /*
             * Rotation has context-sensitive behaviour.
             *
             * Normal mode:
             *   rotate_right = brightness up
             *   rotate_left  = brightness down
             *
             * Temporary CCT mode:
             *   rotate_right = cooler
             *   rotate_left  = warmer
             *
             * IMPORTANT:
             * Every rotation while CCT mode is active resets
             * the inactivity timer back to the full timeout.
             */

            if (
                gesture ===
                    'rotate_right'
            ) {
                if (
                    node.cctModeActive
                ) {
                    resetCctTimer();

                    await applyCommands(
                        'cct_cooler',
                        makeCctCommands(
                            'cooler',
                            infos
                        )
                    );

                    /*
                     * Start a fresh full timeout only after
                     * processing this CCT rotation.
                     */
                    resetCctTimer();
                } else {
                    await applyCommands(
                        'brightness_up',
                        makeBrightnessCommands(
                            'up',
                            infos
                        )
                    );
                }

                return;
            }

            if (
                gesture ===
                    'rotate_left'
            ) {
                if (
                    node.cctModeActive
                ) {
                    resetCctTimer();

                    await applyCommands(
                        'cct_warmer',
                        makeCctCommands(
                            'warmer',
                            infos
                        )
                    );

                    resetCctTimer();
                } else {
                    await applyCommands(
                        'brightness_down',
                        makeBrightnessCommands(
                            'down',
                            infos
                        )
                    );
                }

                return;
            }

            /*
             * Other supported Cube gestures.
             */
            const configuredAction =
                node.gestureActions[
                    gesture
                ];

            await performConfiguredAction(
                configuredAction,
                infos
            );
        }

        function enqueue(
            type,
            data
        ) {
            node.actionQueue =
                node.actionQueue
                    .then(
                        () =>
                            processAction(
                                type,
                                data
                            )
                    )
                    .catch(
                        error => {
                            node.status({
                                fill: 'red',
                                shape: 'ring',
                                text:
                                    error.message
                                        .substring(
                                            0,
                                            32
                                        )
                            });

                            node.error(
                                error.message
                            );
                        }
                    );
        }

        node.status({
            fill: 'grey',
            shape: 'ring',
            text:
                'starting…'
        });

        node.unsub =
            node.server.subscribe(
                enqueue
            );

        node.status({
            fill: 'blue',
            shape: 'ring',
            text:
                'syncing devices…'
        });

        ensureDevices()
            .then(() => {
                node.status({
                    fill: 'green',
                    shape: 'dot',
                    text:
                        `ready • ${node.targetSerials.length} targets`
                });
            })
            .catch(error => {
                node.status({
                    fill: 'yellow',
                    shape: 'ring',
                    text:
                        error.message
                            .substring(
                                0,
                                32
                            )
                });
            });

        node.on(
            'close',
            function(done) {

                clearCctTimer();

                if (
                    node.unsub
                ) {
                    node.unsub();
                }

                done();
            }
        );
    }

    RED.nodes.registerType(
        'mrsmart-ihost-aqara-cube',
        AqaraCubeNode
    );

    /*
     * ---------------------------------------------------------
     * Admin endpoints
     * ---------------------------------------------------------
     */

    RED.httpAdmin.get(
        '/mrsmart-cube-ihost/token',
        RED.auth.needsPermission(
            'mrsmart-cube-ihost.write'
        ),
        async function(req, res) {

            const host =
                normalizeHost(
                    req.query.host
                );

            const appName =
                String(
                    req.query.app_name ||
                    'Mr Smart Aqara Cube Node-RED'
                );

            if (
                !host
            ) {
                return res
                    .status(400)
                    .json({
                        error: 400,
                        message:
                            'Host is required'
                    });
            }

            try {
                const result =
                    await requestJson(
                        'GET',
                        `${host}/open-api/v2/rest/bridge/access_token?app_name=${encodeURIComponent(appName)}`
                    );

                res.json(
                    result
                );
            } catch (e) {
                res.status(200)
                    .json({
                        error: 401,
                        message:
                            e.message
                    });
            }
        }
    );

    RED.httpAdmin.get(
        '/mrsmart-cube-ihost/devices/:server',
        RED.auth.needsPermission(
            'mrsmart-cube-ihost.read'
        ),
        async function(req, res) {

            const server =
                RED.nodes.getNode(
                    req.params.server
                );

            if (
                !server ||
                typeof
                    server.refreshDevices !==
                    'function'
            ) {
                return res
                    .status(404)
                    .json({
                        error: 404,
                        message:
                            'Deploy the iHost configuration first'
                    });
            }

            try {
                const list =
                    await server
                        .refreshDevices();

                res.json({
                    error: 0,
                    data: {
                        device_list:
                            list
                    }
                });
            } catch (e) {
                res.status(500)
                    .json({
                        error: 500,
                        message:
                            e.message
                    });
            }
        }
    );
};
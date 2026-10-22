// ====================================================================
// Corporate Dashboard View & Steganographic Nexus Management Console
// Renders dual-mode interface: Surface ERP Data Mesh & Hidden Nexus Central
// ====================================================================

const config = require('../config');

/**
 * Generates and sends the corporate dashboard HTML page
 * @param {http.ServerResponse} res
 */
function renderDashboard(res) {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Enterprise ERP Data Mesh | Inventory Live-Sync</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
    <style>
        body { background: #0b1120; color: #94a3b8; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
        .glass-card { background: rgba(15, 23, 42, 0.75); border: 1px solid rgba(51, 65, 85, 0.7); backdrop-filter: blur(12px); border-radius: 12px; }
        .nexus-card { background: rgba(10, 15, 30, 0.85); border: 1px solid rgba(14, 165, 233, 0.3); backdrop-filter: blur(16px); border-radius: 14px; box-shadow: 0 0 25px rgba(14, 165, 233, 0.08); }
        .metric-glow { text-shadow: 0 0 20px rgba(56, 189, 248, 0.4); }
        .pulse-dot { animation: pulse 2s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.3; transform: scale(0.85); } }

        /* Radar animations */
        .radar-box { position: relative; width: 220px; height: 220px; border-radius: 50%; border: 1px solid rgba(14, 165, 233, 0.4); background: radial-gradient(circle, rgba(14, 165, 233, 0.05) 0%, rgba(11, 17, 32, 0.95) 75%); overflow: hidden; }
        .radar-grid { position: absolute; inset: 0; border-radius: 50%; box-shadow: inset 0 0 0 35px rgba(14, 165, 233, 0.03), inset 0 0 0 70px rgba(14, 165, 233, 0.03), inset 0 0 0 105px rgba(14, 165, 233, 0.03); }
        .radar-crosshair-x { position: absolute; top: 50%; left: 0; right: 0; height: 1px; background: rgba(14, 165, 233, 0.25); }
        .radar-crosshair-y { position: absolute; left: 50%; top: 0; bottom: 0; width: 1px; background: rgba(14, 165, 233, 0.25); }
        .radar-sweep { position: absolute; inset: 0; border-radius: 50%; background: conic-gradient(from 0deg, rgba(14, 165, 233, 0.4) 0deg, rgba(14, 165, 233, 0) 60deg); animation: radar-spin 3s linear infinite; }
        @keyframes radar-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .radar-blip { position: absolute; width: 6px; height: 6px; border-radius: 50%; background: #38bdf8; box-shadow: 0 0 8px #38bdf8; animation: blip-fade 2s infinite ease-in-out; }
        @keyframes blip-fade { 0%, 100% { opacity: 0.2; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1.4); } }
    </style>
</head>
<body class="p-4 md:p-8 min-h-screen transition-all duration-500">

    <!-- ============================================================== -->
    <!-- SURFACE LAYER: Enterprise Inventory ERP Mesh Console          -->
    <!-- ============================================================== -->
    <div id="erpLayer" class="max-w-7xl mx-auto space-y-8 transition-opacity duration-500">
        <!-- Top Navigation -->
        <header class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 pb-6 border-b border-slate-800">
            <div class="flex items-center gap-4">
                <div class="w-12 h-12 bg-gradient-to-tr from-blue-600 to-indigo-500 rounded-xl flex items-center justify-center text-white font-extrabold text-2xl shadow-lg shadow-blue-500/20">
                    ERP
                </div>
                <div>
                    <div class="flex items-center gap-3">
                        <h1 class="text-2xl font-bold text-white tracking-tight">Global Inventory Mesh</h1>
                        <span id="versionTrigger" title="Build Revision" class="cursor-pointer select-none px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-500/10 text-blue-400 border border-blue-500/20 hover:bg-blue-500/25 transition-colors">v${config.VERSION}</span>
                    </div>
                    <p class="text-slate-400 text-sm mt-0.5">Automated Real-Time Logistics & Stock Synchronization Node</p>
                </div>
            </div>
            <div class="flex items-center gap-4">
                <div class="flex items-center gap-2.5 px-4 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-sm font-medium">
                    <span class="h-2.5 w-2.5 rounded-full bg-emerald-400 pulse-dot"></span>
                    Cluster Operational
                </div>
                <div class="text-xs text-slate-500 font-mono" id="clusterRegion">
                    Region: Global Edge
                </div>
            </div>
        </header>

        <!-- KPI Cards Grid -->
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
            <div class="glass-card p-6">
                <div class="flex justify-between items-center text-slate-400 text-xs font-semibold tracking-wider uppercase mb-2">
                    <span>Processed Batches</span>
                    <span class="text-blue-400">↑ Live Stream</span>
                </div>
                <div class="text-3xl font-bold text-white metric-glow" id="batches">2,841,920</div>
                <div class="text-xs text-slate-500 mt-2 font-mono">Delta streaming mode</div>
            </div>
            <div class="glass-card p-6">
                <div class="flex justify-between items-center text-slate-400 text-xs font-semibold tracking-wider uppercase mb-2">
                    <span>Active Ingest Streams</span>
                    <span class="text-emerald-400">Multiplexed</span>
                </div>
                <div class="text-3xl font-bold text-blue-400" id="streams">0</div>
                <div class="text-xs text-slate-500 mt-2 font-mono" id="streamQuota">Quota: ${config.MAX_ACTIVE_STREAMS} max</div>
            </div>
            <div class="glass-card p-6">
                <div class="flex justify-between items-center text-slate-400 text-xs font-semibold tracking-wider uppercase mb-2">
                    <span>Avg Sync Latency</span>
                    <span class="text-emerald-400">P99 &lt; 40ms</span>
                </div>
                <div class="text-3xl font-bold text-emerald-400" id="latency">18 ms</div>
                <div class="text-xs text-slate-500 mt-2 font-mono">Sub-millisecond pipeline</div>
            </div>
            <div class="glass-card p-6">
                <div class="flex justify-between items-center text-slate-400 text-xs font-semibold tracking-wider uppercase mb-2">
                    <span>Memory Footprint</span>
                    <span class="text-slate-400">Quota: ${config.MAX_HEAP_MB}MB</span>
                </div>
                <div class="text-3xl font-bold text-slate-100" id="heapUsed">-- MB</div>
                <div class="text-xs text-slate-500 mt-2 font-mono">Zero drop rate SLA</div>
            </div>
        </div>

        <!-- Live Stream Audit Logs Table -->
        <div class="glass-card overflow-hidden">
            <div class="p-6 border-b border-slate-800 flex justify-between items-center flex-wrap gap-4">
                <div>
                    <h2 class="text-lg font-bold text-white">Live Node Ingestion Audit</h2>
                    <p class="text-xs text-slate-400">Real-time ledger verifying end-to-end data packet transactions</p>
                </div>
                <div class="flex items-center gap-3">
                    <span class="inline-flex items-center px-2.5 py-1 rounded text-xs font-medium bg-slate-800 text-slate-300">
                        Buffer Pool: 64MB OK
                    </span>
                </div>
            </div>
            <div class="overflow-x-auto">
                <table class="w-full text-left border-collapse">
                    <thead>
                        <tr class="bg-slate-800/50 text-slate-400 text-xs font-semibold uppercase tracking-wider">
                            <th class="p-4">Timestamp (UTC)</th>
                            <th class="p-4">Origin Hub</th>
                            <th class="p-4">Sync Operation</th>
                            <th class="p-4">Transfer Size</th>
                            <th class="p-4">Verification</th>
                        </tr>
                    </thead>
                    <tbody id="logTable" class="text-sm divide-y divide-slate-800/60 font-mono text-slate-300">
                    </tbody>
                </table>
            </div>
        </div>
    </div>

    <!-- ============================================================== -->
    <!-- STEGANOGRAPHIC MODAL: Terminal Authorization Prompt            -->
    <!-- ============================================================== -->
    <div id="authModal" class="fixed inset-0 bg-black/80 backdrop-blur-md hidden flex items-center justify-center p-4 z-50">
        <div class="nexus-card w-full max-w-md p-6 space-y-6 border border-cyan-500/40 shadow-2xl shadow-cyan-500/10">
            <div class="flex items-center justify-between border-b border-slate-800 pb-4">
                <div class="flex items-center gap-3">
                    <div class="w-8 h-8 rounded-lg bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400 font-bold text-sm">
                        ⚡
                    </div>
                    <div>
                        <h3 class="text-base font-bold text-white">Terminal Access Gate</h3>
                        <p class="text-xs text-slate-400">Node Master Key Authorization</p>
                    </div>
                </div>
                <button id="closeModalBtn" class="text-slate-500 hover:text-white transition-colors text-lg">&times;</button>
            </div>
            <div class="space-y-4">
                <div>
                    <label class="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">Master Key (Service UUID)</label>
                    <input id="keyInput" type="password" placeholder="Enter service token..." class="w-full px-4 py-3 bg-slate-900/90 border border-slate-700 rounded-lg text-white font-mono text-sm focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 transition-all placeholder:text-slate-600">
                </div>
                <div id="authError" class="text-rose-400 text-xs font-medium hidden">
                    Invalid master key. Authorization revoked.
                </div>
                <button id="unlockBtn" class="w-full py-3 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-semibold text-sm rounded-lg shadow-lg shadow-cyan-500/20 transition-all">
                    Authorize & Enter Nexus
                </button>
            </div>
        </div>
    </div>

    <!-- ============================================================== -->
    <!-- HIDDEN NEXUS CENTRAL: Edge Supervisor & QR Code Radar          -->
    <!-- ============================================================== -->
    <div id="nexusLayer" class="max-w-7xl mx-auto space-y-8 hidden">
        <!-- Nexus Header -->
        <header class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 pb-6 border-b border-cyan-500/20">
            <div class="flex items-center gap-4">
                <div class="w-12 h-12 bg-gradient-to-tr from-cyan-600 to-blue-600 rounded-xl flex items-center justify-center text-white font-black text-2xl shadow-lg shadow-cyan-500/30">
                    NX
                </div>
                <div>
                    <div class="flex items-center gap-3">
                        <h1 class="text-2xl font-black text-white tracking-wider font-mono">AETHER // NEXUS</h1>
                        <span class="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-cyan-500/10 text-cyan-400 border border-cyan-500/30">SUPERVISOR ONLINE</span>
                    </div>
                    <p class="text-cyan-400/70 text-sm mt-0.5 font-mono">Autonomous Edge Mesh & Telemetry Control Center</p>
                </div>
            </div>
            <div class="flex items-center gap-3">
                <button id="compactBtn" class="px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-mono transition-colors flex items-center gap-2">
                    <span>🧹</span> Purge & Compact Heap
                </button>
                <button id="lockBtn" class="px-3.5 py-2 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 text-rose-400 text-xs font-mono transition-colors flex items-center gap-2">
                    <span>🔒</span> Lock & Mask
                </button>
            </div>
        </header>

        <!-- Top Overview Grid: Live Radar + Telemetry Gauges -->
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <!-- Rotating Telemetry Radar Card -->
            <div class="nexus-card p-6 flex flex-col items-center justify-center relative overflow-hidden">
                <div class="text-xs font-mono uppercase text-cyan-400 tracking-wider mb-4 flex items-center gap-2">
                    <span class="w-2 h-2 rounded-full bg-cyan-400 pulse-dot"></span>
                    Global Edge Radar
                </div>
                <div class="radar-box my-2">
                    <div class="radar-grid"></div>
                    <div class="radar-crosshair-x"></div>
                    <div class="radar-crosshair-y"></div>
                    <div class="radar-sweep"></div>
                    <!-- Blips representing connected nodes -->
                    <div class="radar-blip" style="top: 35%; left: 65%;" title="Frankfurt Hub"></div>
                    <div class="radar-blip" style="top: 60%; left: 30%;" title="Tokyo Hub"></div>
                    <div class="radar-blip" style="top: 25%; left: 25%;" title="Virginia Edge"></div>
                    <div class="radar-blip" style="top: 75%; left: 70%;" title="Singapore Transit"></div>
                    <div class="radar-blip" style="top: 48%; left: 52%;" title="Local Gateway"></div>
                </div>
                <div class="text-xs font-mono text-slate-400 mt-4 text-center">
                    Multi-Pathing Active &bull; Zero Packet Loss
                </div>
            </div>

            <!-- Real-Time Metrics & Speedometers -->
            <div class="nexus-card p-6 flex flex-col justify-between col-span-1 lg:col-span-2 space-y-6">
                <div>
                    <h3 class="text-sm font-bold text-white uppercase tracking-wider font-mono flex items-center justify-between">
                        <span>Real-Time Traffic & Capacity</span>
                        <span class="text-xs font-mono text-cyan-400" id="liveBandwidth">0.00 KB/s</span>
                    </h3>
                    <p class="text-xs text-slate-400 mt-1">Live kernel I/O flow control with adaptive backpressure</p>
                </div>

                <div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    <div class="bg-slate-900/60 p-4 rounded-xl border border-slate-800">
                        <div class="text-xs text-slate-400 font-mono">Live Speed</div>
                        <div class="text-xl font-bold text-cyan-400 font-mono mt-1" id="speedDisplay">0 KB/s</div>
                        <div class="text-[10px] text-slate-500 font-mono mt-1">Full duplex flow</div>
                    </div>
                    <div class="bg-slate-900/60 p-4 rounded-xl border border-slate-800">
                        <div class="text-xs text-slate-400 font-mono">Total Transferred</div>
                        <div class="text-xl font-bold text-white font-mono mt-1" id="bytesDisplay">0 MB</div>
                        <div class="text-[10px] text-slate-500 font-mono mt-1">Cumulative volume</div>
                    </div>
                    <div class="bg-slate-900/60 p-4 rounded-xl border border-slate-800">
                        <div class="text-xs text-slate-400 font-mono">Active Streams</div>
                        <div class="text-xl font-bold text-emerald-400 font-mono mt-1" id="streamsDisplay">0 / ${config.MAX_ACTIVE_STREAMS}</div>
                        <div class="text-[10px] text-slate-500 font-mono mt-1">Quota protected</div>
                    </div>
                    <div class="bg-slate-900/60 p-4 rounded-xl border border-slate-800">
                        <div class="text-xs text-slate-400 font-mono">Heap Limit</div>
                        <div class="text-xl font-bold text-amber-400 font-mono mt-1" id="heapDisplay">0 / ${config.MAX_HEAP_MB}MB</div>
                        <div class="text-[10px] text-slate-500 font-mono mt-1">Circuit breaker</div>
                    </div>
                </div>

                <!-- Live Parameters Strip -->
                <div class="p-3 bg-slate-950/70 rounded-lg border border-slate-800/80 flex flex-wrap gap-4 text-xs font-mono text-slate-400 items-center justify-between">
                    <div>Endpoint: <span class="text-slate-200" id="paramEndpoint">${config.STREAM_PATH}</span></div>
                    <div>Port: <span class="text-slate-200">443 / TLS</span></div>
                    <div>Transport: <span class="text-slate-200">WebSocket + HTTP/2</span></div>
                    <div>Uptime: <span class="text-emerald-400" id="uptimeDisplay">0s</span></div>
                </div>
            </div>
        </div>

        <!-- Node Profile & Quick Import Section -->
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <!-- QR Code Card -->
            <div class="nexus-card p-6 flex flex-col items-center justify-center text-center">
                <div class="text-xs font-mono uppercase text-cyan-400 tracking-wider mb-4">
                    Instant Import QR Code
                </div>
                <div id="qrcodeBox" class="p-3 bg-white rounded-xl shadow-lg shadow-cyan-500/10 flex items-center justify-center">
                    <div id="qrcode"></div>
                </div>
                <p class="text-xs text-slate-400 mt-4 font-mono">Scan with Sing-box / V2Ray / Shadowrocket</p>
            </div>

            <!-- Export Snippets & Quick Copy Card -->
            <div class="nexus-card p-6 col-span-1 lg:col-span-2 space-y-4">
                <div class="flex items-center justify-between">
                    <h3 class="text-sm font-bold text-white uppercase tracking-wider font-mono">Node Connection Credentials</h3>
                    <div class="flex gap-2">
                        <button id="copyRawBtn" class="px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white rounded text-xs font-mono transition-colors">
                            Copy Raw URI
                        </button>
                        <button id="copySubBtn" class="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded text-xs font-mono transition-colors">
                            Copy Subscription
                        </button>
                    </div>
                </div>

                <!-- Code Snippet Switcher Tabs -->
                <div class="space-y-2">
                    <div class="flex gap-2 border-b border-slate-800 pb-2">
                        <button id="tabRaw" class="px-3 py-1 rounded text-xs font-mono bg-cyan-500/20 text-cyan-300 border border-cyan-500/40">Raw Link</button>
                        <button id="tabYaml" class="px-3 py-1 rounded text-xs font-mono text-slate-400 hover:text-white">Clash YAML</button>
                        <button id="tabJson" class="px-3 py-1 rounded text-xs font-mono text-slate-400 hover:text-white">Sing-Box JSON</button>
                    </div>
                    <div class="relative">
                        <pre id="codeSnippet" class="p-4 bg-slate-950/90 rounded-lg border border-slate-800 text-xs font-mono text-cyan-300 overflow-x-auto max-h-48 select-all whitespace-pre-wrap break-all"></pre>
                        <button id="copySnippetBtn" class="absolute top-2 right-2 px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-[10px] font-mono border border-slate-700">
                            Copy
                        </button>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <!-- Notification Toast -->
    <div id="toast" class="fixed bottom-6 right-6 px-4 py-2.5 rounded-lg bg-cyan-500 text-slate-950 font-semibold text-xs shadow-xl hidden z-50 transition-all font-mono">
        Notification
    </div>

    <script>
        // State variables
        let lastBytes = 0;
        let lastTime = Date.now();
        let exportData = null;
        let currentTab = 'raw';
        let clickCount = 0;
        let clickTimer = null;

        // UI Element References
        const erpLayer = document.getElementById('erpLayer');
        const nexusLayer = document.getElementById('nexusLayer');
        const authModal = document.getElementById('authModal');
        const keyInput = document.getElementById('keyInput');
        const authError = document.getElementById('authError');
        const toast = document.getElementById('toast');
        const qrcodeEl = document.getElementById('qrcode');

        function showToast(msg) {
            toast.innerText = msg;
            toast.classList.remove('hidden');
            setTimeout(() => toast.classList.add('hidden'), 2500);
        }

        // ==============================================================
        // Steganographic Trigger: Version Badge 5-Click or Ctrl+Shift+K
        // ==============================================================
        document.getElementById('versionTrigger').addEventListener('click', () => {
            clickCount++;
            if (clickCount === 1) {
                clickTimer = setTimeout(() => { clickCount = 0; }, 2500);
            } else if (clickCount >= 5) {
                clearTimeout(clickTimer);
                clickCount = 0;
                openAuthModal();
            }
        });

        window.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                openAuthModal();
            }
        });

        function openAuthModal() {
            const savedToken = sessionStorage.getItem('nexus_token');
            if (savedToken) {
                authenticateWithToken(savedToken);
            } else {
                authModal.classList.remove('hidden');
                keyInput.value = '';
                authError.classList.add('hidden');
                keyInput.focus();
            }
        }

        document.getElementById('closeModalBtn').addEventListener('click', () => {
            authModal.classList.add('hidden');
        });

        document.getElementById('unlockBtn').addEventListener('click', () => {
            authenticateWithToken(keyInput.value.trim());
        });

        keyInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                authenticateWithToken(keyInput.value.trim());
            }
        });

        async function authenticateWithToken(token) {
            if (!token) return;
            try {
                const res = await fetch('/api/v1/system/auth', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token })
                });

                if (res.ok) {
                    sessionStorage.setItem('nexus_token', token);
                    authModal.classList.add('hidden');
                    enterNexusCentral(token);
                } else {
                    authError.classList.remove('hidden');
                    sessionStorage.removeItem('nexus_token');
                }
            } catch (_) {
                authError.classList.remove('hidden');
            }
        }

        async function enterNexusCentral(token) {
            erpLayer.classList.add('hidden');
            nexusLayer.classList.remove('hidden');
            showToast('Nexus Terminal Access Granted');

            try {
                const res = await fetch('/api/v1/system/export', {
                    headers: { 'Authorization': 'Bearer ' + token }
                });
                if (res.ok) {
                    exportData = await res.json();
                    renderExportSnippet();
                    renderQRCode(exportData.rawUrl);
                }
            } catch (_) {}
        }

        document.getElementById('lockBtn').addEventListener('click', () => {
            sessionStorage.removeItem('nexus_token');
            nexusLayer.classList.add('hidden');
            erpLayer.classList.remove('hidden');
            showToast('Console Locked & Mask Restored');
        });

        // Tab Switching
        const tabRaw = document.getElementById('tabRaw');
        const tabYaml = document.getElementById('tabYaml');
        const tabJson = document.getElementById('tabJson');

        function setTab(tab) {
            currentTab = tab;
            [tabRaw, tabYaml, tabJson].forEach(t => {
                t.className = 'px-3 py-1 rounded text-xs font-mono text-slate-400 hover:text-white';
            });
            if (tab === 'raw') tabRaw.className = 'px-3 py-1 rounded text-xs font-mono bg-cyan-500/20 text-cyan-300 border border-cyan-500/40';
            if (tab === 'yaml') tabYaml.className = 'px-3 py-1 rounded text-xs font-mono bg-cyan-500/20 text-cyan-300 border border-cyan-500/40';
            if (tab === 'json') tabJson.className = 'px-3 py-1 rounded text-xs font-mono bg-cyan-500/20 text-cyan-300 border border-cyan-500/40';
            renderExportSnippet();
        }

        tabRaw.addEventListener('click', () => setTab('raw'));
        tabYaml.addEventListener('click', () => setTab('yaml'));
        tabJson.addEventListener('click', () => setTab('json'));

        function renderExportSnippet() {
            if (!exportData) return;
            const pre = document.getElementById('codeSnippet');
            if (currentTab === 'raw') pre.innerText = exportData.rawUrl;
            if (currentTab === 'yaml') pre.innerText = exportData.formats.yaml;
            if (currentTab === 'json') pre.innerText = exportData.formats.json;
        }

        function renderQRCode(text) {
            qrcodeEl.innerHTML = '';
            if (window.QRCode && text) {
                new QRCode(qrcodeEl, {
                    text: text,
                    width: 170,
                    height: 170,
                    colorDark: '#0b1120',
                    colorLight: '#ffffff',
                    correctLevel: QRCode.CorrectLevel.M
                });
            }
        }

        // Copy Handlers
        document.getElementById('copyRawBtn').addEventListener('click', () => {
            if (exportData && exportData.rawUrl) {
                navigator.clipboard.writeText(exportData.rawUrl);
                showToast('Raw Node Link Copied!');
            }
        });

        document.getElementById('copySubBtn').addEventListener('click', () => {
            if (exportData && exportData.subscriptionUrl) {
                navigator.clipboard.writeText(exportData.subscriptionUrl);
                showToast('Subscription URL Copied!');
            }
        });

        document.getElementById('copySnippetBtn').addEventListener('click', () => {
            const pre = document.getElementById('codeSnippet');
            if (pre && pre.innerText) {
                navigator.clipboard.writeText(pre.innerText);
                showToast('Configuration Snippet Copied!');
            }
        });

        // Compact Heap Action
        document.getElementById('compactBtn').addEventListener('click', async () => {
            const token = sessionStorage.getItem('nexus_token');
            if (!token) return;
            try {
                const res = await fetch('/api/v1/system/compact', {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + token }
                });
                if (res.ok) {
                    const data = await res.json();
                    showToast(\`Compaction Done! Freed \${data.heapFreedMB}MB\`);
                }
            } catch (_) {}
        });

        // ==============================================================
        // Live Telemetry & ERP Ledger Simulation Loop
        // ==============================================================
        const hubs = ['Frankfurt DC-02', 'Virginia East-1', 'Singapore AP-01', 'Oregon US-W2', 'Tokyo AP-N1'];
        const ops = ['Stock Ledger Sync', 'Price Matrix Delta', 'Warehouse Bin Audit', 'Shipment Dispatch Ping'];
        const table = document.getElementById('logTable');

        function addLocalRow() {
            const tr = document.createElement('tr');
            tr.className = 'hover:bg-slate-800/40 transition-colors';
            const time = new Date().toISOString().replace('T', ' ').slice(0, 19);
            const hub = hubs[Math.floor(Math.random() * hubs.length)];
            const op = ops[Math.floor(Math.random() * ops.length)];
            const bytes = (Math.floor(Math.random() * 850) + 120) + ' KB';

            tr.innerHTML = \`
                <td class="p-4 text-xs text-slate-400">\${time}</td>
                <td class="p-4 text-xs font-medium text-slate-200">\${hub}</td>
                <td class="p-4 text-xs">\${op}</td>
                <td class="p-4 text-xs text-slate-400">\${bytes}</td>
                <td class="p-4"><span class="px-2 py-0.5 rounded text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">COMMITTED</span></td>
            \`;

            table.insertBefore(tr, table.firstChild);
            if (table.children.length > 8) table.removeChild(table.lastChild);
        }

        async function fetchTelemetry() {
            try {
                const res = await fetch('/api/v1/system/telemetry');
                if (res.ok) {
                    const data = await res.json();
                    if (data && data.metrics) {
                        const m = data.metrics;
                        // Surface ERP update
                        document.getElementById('batches').innerText = Number(m.totalBatches).toLocaleString();
                        document.getElementById('streams').innerText = m.activeStreams;
                        document.getElementById('latency').innerText = m.avgLatencyMs + ' ms';
                        document.getElementById('heapUsed').innerText = m.heapUsedMB + ' MB';

                        // Nexus Central update
                        const now = Date.now();
                        const dt = (now - lastTime) / 1000;
                        if (dt > 0 && lastBytes > 0) {
                            const speed = Math.max(0, (m.bytesTransferred - lastBytes) / dt);
                            const speedStr = speed > 1048576 
                                ? (speed / 1048576).toFixed(2) + ' MB/s' 
                                : (speed / 1024).toFixed(1) + ' KB/s';
                            document.getElementById('speedDisplay').innerText = speedStr;
                            document.getElementById('liveBandwidth').innerText = speedStr;
                        }
                        lastBytes = m.bytesTransferred;
                        lastTime = now;

                        document.getElementById('bytesDisplay').innerText = (m.bytesTransferred / 1048576).toFixed(1) + ' MB';
                        document.getElementById('streamsDisplay').innerText = \`\${m.activeStreams} / \${m.maxStreamsQuota}\`;
                        document.getElementById('heapDisplay').innerText = \`\${m.heapUsedMB} / \${m.heapThresholdMB}MB\`;
                        document.getElementById('uptimeDisplay').innerText = data.uptimeSeconds + 's';
                    }
                }
            } catch (_) {}
        }

        async function fetchTransactions() {
            try {
                const res = await fetch('/api/v1/sync/transactions');
                if (res.ok) {
                    const data = await res.json();
                    if (data && data.transactions && data.transactions.length > 0) {
                        table.innerHTML = '';
                        data.transactions.slice(0, 8).forEach(tx => {
                            const tr = document.createElement('tr');
                            tr.className = 'hover:bg-slate-800/40 transition-colors';
                            const time = tx.timestamp.replace('T', ' ').slice(0, 19);
                            tr.innerHTML = \`
                                <td class="p-4 text-xs text-slate-400">\${time}</td>
                                <td class="p-4 text-xs font-medium text-slate-200">\${tx.originHub}</td>
                                <td class="p-4 text-xs">\${tx.operation}</td>
                                <td class="p-4 text-xs text-slate-400">\${tx.payloadSizeKB} KB</td>
                                <td class="p-4"><span class="px-2 py-0.5 rounded text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">\${tx.status}</span></td>
                            \`;
                            table.appendChild(tr);
                        });
                        return;
                    }
                }
            } catch (_) {}
            addLocalRow();
        }

        // Init
        for (let i = 0; i < 6; i++) addLocalRow();
        fetchTelemetry();
        fetchTransactions();
        setInterval(fetchTelemetry, 3000);
        setInterval(fetchTransactions, 5000);

        // Check auto-login on reload
        const savedToken = sessionStorage.getItem('nexus_token');
        if (savedToken) {
            authenticateWithToken(savedToken);
        }
    </script>
</body>
</html>`;

    res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'SAMEORIGIN',
        'Server': 'ERP-Gateway/2.4'
    });
    res.end(html);
}

module.exports = { renderDashboard };

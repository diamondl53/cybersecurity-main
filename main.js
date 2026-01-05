const ADMIN_PASSWORD = "ADMIN1234"; 
let isAdminAuthenticated = false;

const firebaseConfig = {
    apiKey: "AIzaSyAMyTn2KYF9A5pd4FsDjYoOMVzZiGDS5mw",
    authDomain: "cybersecurity-24e2f.firebaseapp.com",
    databaseURL: "https://cybersecurity-24e2f-default-rtdb.firebaseio.com",
    projectId: "cybersecurity-24e2f",
    storageBucket: "cybersecurity-24e2f.firebasestorage.app",
    messagingSenderId: "717149409586",
    appId: "1:717149409586:web:93ecffa8769bb61c17472b",
    measurementId: "G-MN26WVJ2YB"
};

if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// --- CRYPTO ---
function stringify(obj) { return JSON.stringify(obj, Object.keys(obj).sort()); }
async function sha256(data) {
    const msgBuffer = new TextEncoder().encode(data);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// --- BLOCKCHAIN LOGIC ---
class Transaction {
    constructor(sender, recipient, amount, signature = "") {
        this.sender = sender; this.recipient = recipient; this.amount = parseFloat(amount); this.signature = signature;
    }
    async sign(priv) {
        if (this.sender === 'SYSTEM') this.signature = "SYSTEM_SIG";
        else this.signature = await sha256(priv + stringify({sender: this.sender, recipient: this.recipient, amount: this.amount}));
    }
}

class Block {
    constructor(index, transactions, prevHash, nonce = 0) {
        this.index = index; this.transactions = transactions; this.previous_hash = prevHash; this.nonce = nonce; this.timestamp = Date.now()/1000;
    }
    async computeHash() { return await sha256(stringify(this)); }
}

class Blockchain {
    constructor() { this.difficulty = 3; this.unconfirmed_transactions = []; this.chain = []; this.balances = {}; }
    sync(data) { this.chain = data.chain || []; this.unconfirmed_transactions = data.unconfirmed_transactions || []; this.recalculateBalances(); }
    async save() { await db.ref('blockchain').set({ chain: this.chain, unconfirmed_transactions: this.unconfirmed_transactions }); }
    recalculateBalances() {
        this.balances = {};
        this.chain.forEach(b => {
            if (b.transactions) b.transactions.forEach(tx => {
                if (tx.sender !== "SYSTEM") this.balances[tx.sender] = (this.balances[tx.sender] || 0) - tx.amount;
                this.balances[tx.recipient] = (this.balances[tx.recipient] || 0) + tx.amount;
            });
        });
    }
    async mine() {
        const last = this.chain[this.chain.length - 1];
        const b = new Block(this.chain.length, this.unconfirmed_transactions, last.hash);
        while (true) {
            b.hash = await b.computeHash();
            if (b.hash.startsWith("0".repeat(this.difficulty))) break;
            b.nonce++;
        }
        this.chain.push(JSON.parse(JSON.stringify(b)));
        this.unconfirmed_transactions = [];
        await this.save();
        return b;
    }
}

const bc = new Blockchain();

// --- ADMIN FUNCTIONS ---
function unlockSystem() {
    if (document.getElementById('admin-pass-input').value === ADMIN_PASSWORD) {
        isAdminAuthenticated = true;
        renderAdminView();
        refreshUI();
        showNotification("Admin access granted.");
    } else {
        showNotification("Incorrect password!", true);
    }
}

function renderAdminView() {
    const login = document.getElementById('admin-login-section');
    const ctrl = document.getElementById('admin-controls-section');
    if (isAdminAuthenticated) { login.classList.add('hidden'); ctrl.classList.remove('hidden'); }
    else { login.classList.remove('hidden'); ctrl.classList.add('hidden'); }
}

async function mineBlock() {
    if (!isAdminAuthenticated) return showNotification("Auth Required", true);
    if (bc.unconfirmed_transactions.length === 0) return showNotification("Mempool Empty", true);
    showNotification("Mining...");
    await bc.mine();
    showNotification("Block Mined!");
}

async function clearMempool() {
    if (!isAdminAuthenticated) return showNotification("Auth Required", true);
    if (bc.unconfirmed_transactions.length === 0) return showNotification("Already empty", true);
    if (confirm("Clear all pending transactions?")) {
        bc.unconfirmed_transactions = [];
        await bc.save();
        showNotification("Mempool cleared.");
    }
}

async function wipeBlockchain() {
    if (isAdminAuthenticated && confirm("Wipe entire chain?")) {
        await db.ref('blockchain').remove();
        showNotification("Resetting...");
    }
}

// --- UI & SYNC ---
db.ref('blockchain').on('value', s => {
    const d = s.val();
    if (d && d.chain) { bc.sync(d); refreshUI(); } 
    else { initGenesis(); }
});

async function initGenesis() {
    const g = new Block(0, [], "0");
    g.hash = await g.computeHash();
    bc.chain = [JSON.parse(JSON.stringify(g))];
    await bc.save();
}

function refreshUI() {
    bc.recalculateBalances();
    // Balances
    let bView = "ADDR | BAL\n---\n";
    Object.keys(bc.balances).forEach(a => { bView += `${a} | ${bc.balances[a].toFixed(2)}\n`});
    document.getElementById('balances-view').textContent = bView || "(No balances)";

    // Mempool (Privacy Logic)
    const memElement = document.getElementById('mempool-view');
    const count = bc.unconfirmed_transactions.length;
    if (isAdminAuthenticated) {
        let memText = `PENDING: ${count}\n\n`;
        bc.unconfirmed_transactions.forEach((tx, i) => {
            memText += `[${i+1}] ${tx.sender.substring(0,8)} -> ${tx.recipient.substring(0,8)} (${tx.amount})\n`;
        });
        memElement.textContent = memText || "(Empty)";
    } else {
        memElement.textContent = `Mempool: ${count} transaction(s) waiting.`;
    }

    // Chain
    let cView = "";
    bc.chain.slice().reverse().forEach(b => cView += `BLOCK #${b.index}\nHash: ${b.hash.substring(0,10)}...\n\n`);
    document.getElementById('chain-view').textContent = cView;
}

async function sendTokens() {
    const p = document.getElementById('send-priv').value.trim();
    const s = document.getElementById('send-pub').value.trim();
    const r = document.getElementById('send-recipient').value.trim();
    const a = parseFloat(document.getElementById('send-amount').value);
    if (!p || (bc.balances[s] || 0) < a) return showNotification("Insufficient balance/Incorrect keys", true);

    if (a <= 0) return showNotification("Amount must be greater than 0", true)
    const tx = new Transaction(s, r, a);
    await tx.sign(p);
    bc.unconfirmed_transactions.push(JSON.parse(JSON.stringify(tx)));
    await bc.save();
    showNotification("Sent to Mempool");
    await bc.mine();
    checkSenderBalance();
}

async function issueTokens() {
    if (!isAdminAuthenticated) return;
    const r = document.getElementById('issue-recipient').value.trim();
    const a = parseFloat(document.getElementById('issue-amount').value);
    const tx = new Transaction("SYSTEM", r, a);
    await tx.sign(null);
    bc.unconfirmed_transactions.push(JSON.parse(JSON.stringify(tx)));
    await bc.save();
    showNotification("Issued tokens.");
}

function showTab(id) {
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-button').forEach(b => b.classList.remove('active'));
    if (id === 'issue') renderAdminView();
    document.getElementById(id).classList.add('active');
    if (event && event.currentTarget) event.currentTarget.classList.add('active');
}

function showNotification(m, e=false) {
    const n = document.getElementById('notification');
    n.textContent = m; n.className = `show ${e?'error':'success'}`;
    setTimeout(()=>n.classList.remove('show'), 3000);
}

function generateWallet() {
    document.getElementById('new-priv').value = "PRIV-"+Math.random().toString(36).substr(2,9).toUpperCase();
    document.getElementById('new-pub').value = "ADDR-"+Math.random().toString(36).substr(2,9).toUpperCase();
}

function checkSenderBalance() {
    const a = document.getElementById('send-pub').value.trim();
    document.getElementById('sender-balance').textContent = (bc.balances[a] || 0).toFixed(2);
}

function refreshStatus() { refreshUI(); }
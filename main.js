// --- CONFIGURATION ---
const ADMIN_PASSWORD = "ADMIN1234"; // Your hardcoded password
let isAdminAuthenticated = false;   // Session variable (resets on refresh)

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

// Initialize Firebase
if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}
const db = firebase.database();

// --- CRYPTO UTILS ---
function stringify(obj) {
    return JSON.stringify(obj, Object.keys(obj).sort());
}

async function sha256(data) {
    const msgBuffer = new TextEncoder().encode(data);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// --- BLOCKCHAIN CLASSES ---
class Transaction {
    constructor(sender, recipient, amount, signature = "") {
        this.sender = sender;
        this.recipient = recipient;
        this.amount = parseFloat(amount);
        this.signature = signature;
    }
    async sign(privateKey) {
        if (this.sender === 'SYSTEM') {
            this.signature = "SYSTEM_TX_NO_SIGNATURE";
        } else {
            const msg = stringify({sender: this.sender, recipient: this.recipient, amount: this.amount});
            this.signature = await sha256(privateKey + msg);
        }
    }
}

class Block {
    constructor(index, transactions, previousHash, nonce = 0, timestamp = Date.now() / 1000) {
        this.index = index;
        this.transactions = transactions;
        this.timestamp = timestamp;
        this.previous_hash = previousHash;
        this.nonce = nonce;
        this.hash = "";
    }
    async computeHash() {
        return await sha256(stringify({
            index: this.index,
            transactions: this.transactions,
            timestamp: this.timestamp,
            previous_hash: this.previous_hash,
            nonce: this.nonce
        }));
    }
}

class Blockchain {
    constructor() {
        this.difficulty = 3;
        this.unconfirmed_transactions = [];
        this.chain = [];
        this.balances = {};
    }

    sync(data) {
        this.chain = data.chain || [];
        this.unconfirmed_transactions = data.unconfirmed_transactions || [];
        this.recalculateBalances();
    }

    async save() {
        try {
            await db.ref('blockchain').set({
                chain: this.chain,
                unconfirmed_transactions: this.unconfirmed_transactions
            });
        } catch (e) {
            showNotification("Firebase Save Error", true);
        }
    }

    recalculateBalances() {
        this.balances = {};
        this.chain.forEach(block => {
            if (block.transactions) {
                block.transactions.forEach(tx => {
                    if (tx.sender !== "SYSTEM") {
                        this.balances[tx.sender] = (this.balances[tx.sender] || 0) - tx.amount;
                    }
                    this.balances[tx.recipient] = (this.balances[tx.recipient] || 0) + tx.amount;
                });
            }
        });
    }

    async mine() {
        const lastBlock = this.chain[this.chain.length - 1];
        const newBlock = new Block(
            this.chain.length,
            this.unconfirmed_transactions,
            lastBlock ? lastBlock.hash : "0"
        );

        const target = "0".repeat(this.difficulty);
        while (true) {
            newBlock.hash = await newBlock.computeHash();
            if (newBlock.hash.startsWith(target)) break;
            newBlock.nonce++;
        }
        
        this.chain.push(JSON.parse(JSON.stringify(newBlock)));
        this.unconfirmed_transactions = [];
        await this.save();
        return newBlock;
    }
}

const bc = new Blockchain();

// --- DATABASE LISTENER ---
db.ref('blockchain').on('value', (snapshot) => {
    const data = snapshot.val();
    if (data && data.chain) {
        bc.sync(data);
        refreshUI();
    } else {
        initGenesis();
    }
});

async function initGenesis() {
    const genesis = new Block(0, [], "0", 0, 1704067200);
    genesis.hash = await genesis.computeHash();
    bc.chain = [JSON.parse(JSON.stringify(genesis))];
    bc.unconfirmed_transactions = [];
    await bc.save();
}

// --- ADMIN & AUTH FUNCTIONS ---
function unlockSystem() {
    const input = document.getElementById('admin-pass-input').value;
    if (input === ADMIN_PASSWORD) {
        isAdminAuthenticated = true;
        renderAdminView();
        showNotification("Admin access granted.");
    } else {
        showNotification("Incorrect password!", true);
    }
}

function renderAdminView() {
    const loginSec = document.getElementById('admin-login-section');
    const ctrlSec = document.getElementById('admin-controls-section');
    if (isAdminAuthenticated) {
        loginSec.classList.add('hidden');
        ctrlSec.classList.remove('hidden');
    } else {
        loginSec.classList.remove('hidden');
        ctrlSec.classList.add('hidden');
    }
}

async function wipeBlockchain() {
    if (!isAdminAuthenticated) return;
    if (confirm("DELETE EVERYTHING? This cannot be undone.")) {
        showNotification("Wiping data...");
        await db.ref('blockchain').remove();
        await initGenesis();
        showNotification("Network reset.");
    }
}

async function mineBlock() {
    if (!isAdminAuthenticated) return showNotification("Login as Admin to mine", true);
    if (bc.unconfirmed_transactions.length === 0) return showNotification("Mempool is empty", true);
    
    showNotification("Mining block...");
    const block = await bc.mine();
    if (block) showNotification("Success! Mined Block #" + block.index);
}

// --- CORE ACTIONS ---
async function sendTokens() {
    const priv = document.getElementById('send-priv').value.trim();
    const sender = document.getElementById('send-pub').value.trim();
    const recipient = document.getElementById('send-recipient').value.trim();
    const amount = parseFloat(document.getElementById('send-amount').value);

    if (!priv || (bc.balances[sender] || 0) < amount) {
        return showNotification("Invalid Keys or Low Balance", true);
    }

    const tx = new Transaction(sender, recipient, amount);
    await tx.sign(priv);
    bc.unconfirmed_transactions.push(JSON.parse(JSON.stringify(tx)));
    await bc.save();
    showNotification("Transaction added to Mempool.");
}

async function issueTokens() {
    if (!isAdminAuthenticated) return;
    const recipient = document.getElementById('issue-recipient').value.trim();
    const amount = parseFloat(document.getElementById('issue-amount').value);
    
    const tx = new Transaction("SYSTEM", recipient, amount);
    await tx.sign(null);
    bc.unconfirmed_transactions.push(JSON.parse(JSON.stringify(tx)));
    await bc.save();
    showNotification("System tokens issued.");
}

// --- UI UPDATES ---
function refreshUI() {
    bc.recalculateBalances();
    
    // Balances
    let balText = 'ADDR | BALANCE\n---\n';
    Object.keys(bc.balances).forEach(addr => {
        if (bc.balances[addr] > 0) {
            balText += `${addr.substring(0,8)}... | ${bc.balances[addr].toFixed(2)}\n`;
        }
    });
    document.getElementById('balances-view').textContent = balText;

    // Mempool
    document.getElementById('mempool-view').textContent = bc.unconfirmed_transactions.length + " Pending Transactions";

    // Chain
    let chainText = "";
    bc.chain.slice().reverse().forEach(block => {
        chainText += `BLOCK #${block.index}\nHash: ${block.hash.substring(0,12)}...\n\n`;
    });
    document.getElementById('chain-view').textContent = chainText;
}

function showTab(id) {
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-button').forEach(b => b.classList.remove('active'));
    if (id === 'issue') renderAdminView();
    document.getElementById(id).classList.add('active');
    if (event && event.currentTarget) event.currentTarget.classList.add('active');
}

function showNotification(msg, isErr = false) {
    const n = document.getElementById('notification');
    n.textContent = msg;
    n.className = `show ${isErr ? 'error' : 'success'}`;
    setTimeout(() => n.classList.remove('show'), 3000);
}

function generateWallet() {
    const priv = `PRIV-${Math.random().toString(36).substring(2,11).toUpperCase()}`;
    const pub = `ADDR-${Math.random().toString(36).substring(2,11).toUpperCase()}`;
    document.getElementById('new-priv').value = priv;
    document.getElementById('new-pub').value = pub;
}

function checkSenderBalance() {
    const addr = document.getElementById('send-pub').value.trim();
    document.getElementById('sender-balance').textContent = (bc.balances[addr] || 0).toFixed(2);
}

function refreshStatus() { refreshUI(); showNotification("UI Updated"); }
// 1. Firebase Configuration
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
    message() {
        return stringify({sender: this.sender, recipient: this.recipient, amount: this.amount});
    }
    async sign(privateKey) {
        if (this.sender === 'SYSTEM') this.signature = "SYSTEM_TX_NO_SIGNATURE";
        else this.signature = await sha256(privateKey + this.message());
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
        const blockString = stringify({
            index: this.index,
            transactions: this.transactions,
            timestamp: this.timestamp,
            previous_hash: this.previous_hash,
            nonce: this.nonce
        });
        return await sha256(blockString);
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
            showNotification("Firebase Save Error: " + e.message, true);
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
        if (this.unconfirmed_transactions.length === 0) return null;

        const lastBlock = this.chain[this.chain.length - 1];
        const newBlock = new Block(
            this.chain.length,
            this.unconfirmed_transactions,
            lastBlock ? lastBlock.hash : "0"
        );

        // PoW Loop
        const target = "0".repeat(this.difficulty);
        let computed = "";
        while (true) {
            computed = await newBlock.computeHash();
            if (computed.startsWith(target)) break;
            newBlock.nonce++;
            if (newBlock.nonce > 100000) break; // Safety break
        }
        
        newBlock.hash = computed;
        this.chain.push(JSON.parse(JSON.stringify(newBlock))); // Clean object for Firebase
        this.unconfirmed_transactions = [];
        await this.save();
        return newBlock;
    }
}

const bc = new Blockchain();

// --- CONNECTION LISTENER ---
db.ref('blockchain').on('value', (snapshot) => {
    const data = snapshot.val();
    if (data && data.chain) {
        bc.sync(data);
        refreshUI();
    } else {
        // If the DB is totally empty, create the very first block
        initGenesis();
    }
}, (error) => {
    showNotification("Database Connection Failed!", true);
    console.error(error);
});

async function initGenesis() {
    console.log("Initializing Genesis...");
    const genesis = new Block(0, [], "0", 0, 1704067200);
    genesis.hash = await genesis.computeHash();
    bc.chain = [JSON.parse(JSON.stringify(genesis))];
    bc.unconfirmed_transactions = [];
    await bc.save();
}

// --- UI UPDATES ---
function refreshUI() {
    bc.recalculateBalances();
    
    // Update Balances
    let balView = document.getElementById('balances-view');
    let balText = 'Address | Balance\n' + '-'.repeat(30) + '\n';
    let hasBal = false;
    Object.keys(bc.balances).forEach(addr => {
        if (bc.balances[addr] > 0) {
            balText += `${addr.substring(0,10)}... | ${bc.balances[addr].toFixed(2)}\n`;
            hasBal = true;
        }
    });
    balView.textContent = hasBal ? balText : "(No balances yet)";

    // Update Mempool
    let memView = document.getElementById('mempool-view');
    let memText = "";
    bc.unconfirmed_transactions.forEach(tx => {
        memText += `${tx.sender.substring(0,8)} -> ${tx.recipient.substring(0,8)} [${tx.amount}]\n`;
    });
    memView.textContent = memText || "(Mempool Empty)";

    // Update Chain
    let chainView = document.getElementById('chain-view');
    let chainText = "";
    bc.chain.slice().reverse().forEach(block => {
        chainText += `BLOCK #${block.index}\nHash: ${block.hash.substring(0,12)}...\nTXs: ${block.transactions ? block.transactions.length : 0}\n\n`;
    });
    chainView.textContent = chainText;
    
    checkSenderBalance();
}

// --- ACTION FUNCTIONS ---
async function sendTokens() {
    const priv = document.getElementById('send-priv').value.trim();
    const sender = document.getElementById('send-pub').value.trim();
    const recipient = document.getElementById('send-recipient').value.trim();
    const amount = parseFloat(document.getElementById('send-amount').value);

    if (!priv || (bc.balances[sender] || 0) < amount) {
        return showNotification("Invalid Keys or Insufficient Funds", true);
    }

    const tx = new Transaction(sender, recipient, amount);
    await tx.sign(priv);
    bc.unconfirmed_transactions.push(JSON.parse(JSON.stringify(tx)));
    await bc.save();
    showNotification("Transaction sent to Mempool!");
    const block = await bc.mine();
}

async function issueTokens() {
    const recipient = document.getElementById('issue-recipient').value.trim();
    const amount = parseFloat(document.getElementById('issue-amount').value);
    if (!recipient || isNaN(amount)) return showNotification("Check inputs", true);

    const tx = new Transaction("SYSTEM", recipient, amount);
    await tx.sign(null);
    bc.unconfirmed_transactions.push(JSON.parse(JSON.stringify(tx)));
    await bc.save();
    showNotification("System Tokens Issued!");
}

async function mineBlock() {
    if (bc.unconfirmed_transactions.length === 0) {
        return showNotification("Nothing to mine!", true);
    }
    showNotification("Mining block... stay on this page.");
    const block = await bc.mine();
    if (block) showNotification("Success! Block #" + block.index + " mined.");
}

// --- TAB & WALLET LOGIC ---
function showTab(id) {
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-button').forEach(b => b.classList.remove('active'));
    document.getElementById(id).classList.add('active');
    event.currentTarget.classList.add('active');
}

function showNotification(msg, isErr = false) {
    const n = document.getElementById('notification');
    n.textContent = msg;
    n.className = `show ${isErr ? 'error' : 'success'}`;
    setTimeout(() => n.classList.remove('show'), 3000);
}

function checkSenderBalance() {
    const addr = document.getElementById('send-pub').value.trim();
    document.getElementById('sender-balance').textContent = (bc.balances[addr] || 0).toFixed(2);
}

async function generateWallet() {
    const priv = `PRIV-${Math.random().toString(36).substring(2).toUpperCase()}`;
    const pub = `ADDR-${crypto.randomUUID().replaceAll('-', '').substring(0,12).toUpperCase()}`;
    document.getElementById('new-priv').value = priv;
    document.getElementById('new-pub').value = pub;
}

function refreshStatus() {
    refreshUI();
    showNotification("Manual Refresh Complete");
}
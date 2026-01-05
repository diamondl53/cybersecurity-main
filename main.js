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
    bc.recalculateBalances(); 
    refreshUI();
    checkSenderBalance();
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

        await db.ref('wallet_registry').remove();

        localStorage.removeItem('faucet_claimed');
        hasClaimedFaucet = false;

        showNotification("System Fully Wiped.");

        location.reload();
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
    bc.recalculateBalances(); // [cite: 14]

    // Update the main Balances table to show "Available" balances 
    let bView = "ADDR | AVAILABLE BAL\n---\n";
    Object.keys(bc.balances).forEach(a => { 
        const avail = getAvailableBalance(a);
        bView += `${a} | ${avail.toFixed(2)}\n`;
    });
    document.getElementById('balances-view').textContent = bView || "(No balances)";

    // Update Mempool View [cite: 31, 33]
    const memElement = document.getElementById('mempool-view');
    const count = bc.unconfirmed_transactions.length;
    if (isAdminAuthenticated) {
        let memText = `PENDING: ${count}\n\n`;
        bc.unconfirmed_transactions.forEach((tx, i) => {
            memText += `[${i+1}] ${tx.sender} -> ${tx.recipient} (${tx.amount})\n`;
        });
        memElement.textContent = memText || "(Empty)";
    } else {
        memElement.textContent = `Mempool: ${count} transaction(s) waiting.`;
    }

    // Update Chain View [cite: 35]
    let cView = "";
    bc.chain.slice().reverse().forEach(b => cView += `BLOCK #${b.index}\nHash: ${b.hash.substring(0,10)}...\n\n`);
    document.getElementById('chain-view').textContent = cView;
    
    // Auto-update the balance in the "Send" tab if an address is already entered [cite: 45]
    checkSenderBalance();
}

async function sendTokens() {
    const p = document.getElementById('send-priv').value.trim();
    const s = document.getElementById('send-pub').value.trim();
    const r = document.getElementById('send-recipient').value.trim();
    const a = parseFloat(document.getElementById('send-amount').value);

    const snapshot = await db.ref('wallet_registry').child(s).once('value');
    const officialPrivKey = snapshot.val();

    if (p !== officialPrivKey) {
        return showNotification("Private key is incorrect!", true);
    }

    const available = getAvailableBalance(s);
    if (available < a) {
        return showNotification(`Insufficient funds! You have ${available.toFixed(2)} available (some may be pending in mempool).`, true);
    }

    if (isNaN(a) || a <= 0) return showNotification("Amount must be a number greater than 0!", true);

    if (!(r in bc.balances)) {
        return showNotification("Recipient address does not exist on the network!", true);
    }


    const tx = new Transaction(s, r, a);
    await tx.sign(p);
    bc.unconfirmed_transactions.push(JSON.parse(JSON.stringify(tx)));
    await bc.save();
    showNotification("Sent to Mempool");
    checkSenderBalance();
}

async function issueTokens() {
    if (!isAdminAuthenticated) return;
    const r = document.getElementById('issue-recipient').value.trim();
    const a = parseFloat(document.getElementById('issue-amount').value);

    if (!(r in bc.balances)){
        const priv = "PRIV-"+Math.random().toString(36).substr(2,9).toUpperCase();
        document.getElementById('new-priv').value = priv;
        document.getElementById('new-pub').value = r;
        db.ref('wallet_registry').child(r).set(priv);
    }
    const tx = new Transaction("SYSTEM", r, a);
    await tx.sign(null);
    bc.unconfirmed_transactions.push(JSON.parse(JSON.stringify(tx)));
    await bc.save();
    await bc.mine();
    showNotification("Issued tokens.");
    checkSenderBalance();
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



function checkSenderBalance() {
    const a = document.getElementById('send-pub').value.trim();
    const available = getAvailableBalance(a);
    const display = document.getElementById('sender-balance');
    if (display) {
        display.textContent = available.toFixed(2);
        // Visual cue: if balance is 0 or less, make it red
        display.style.color = available <= 0 ? "#ff3333" : "#ffcc00"; 
    }
}

function refreshStatus() { 
    showNotification("Forced a Refresh.");
    refreshUI(); }

// Updated generateWallet to show the faucet button
let sessionFaucetClaimed = false; // Prevents spamming within one session

function generateWallet() {
    const priv = "PRIV-"+Math.random().toString(36).substr(2,9).toUpperCase();
    const pub = "ADDR-"+Math.random().toString(36).substr(2,9).toUpperCase();
    
    document.getElementById('new-priv').value = priv;
    document.getElementById('new-pub').value = pub;

    // Auto-fill the Send Tab fields for convenience
    document.getElementById('send-priv').value = priv;
    document.getElementById('send-pub').value = pub;
    checkSenderBalance(); // Update balance display in send tab [cite: 45]

    // db.ref('wallet_registry').child(pub).set(priv);

    // Show faucet button ONLY if they haven't claimed this session
    const fBtn = document.getElementById('faucet-btn');
    if (!sessionFaucetClaimed) {
        fBtn.classList.remove('hidden');
        fBtn.disabled = false;
        fBtn.textContent = "Claim 1,000 Starter Tokens";
    }
}
// New function to add tokens to the mempool
async function claimFaucet() {
    if (sessionFaucetClaimed) return;
    
    const r = document.getElementById('new-pub').value.trim();
    if (!r) return;

    const pub = document.getElementById('new-pub').value.trim();
    const priv = document.getElementById('new-priv').value.trim();

    await db.ref('wallet_registry').child(pub).set(priv);

    // Create system transaction using existing logic [cite: 40]
    const tx = new Transaction("SYSTEM", r, 1000);
    await tx.sign(null); // [cite: 6]
    
    bc.unconfirmed_transactions.push(JSON.parse(JSON.stringify(tx)));
    await bc.save(); // Sync to Firebase [cite: 13]
    
    // Lock the faucet for this session to prevent spam
    sessionFaucetClaimed = true;
    const fBtn = document.getElementById('faucet-btn');
    fBtn.disabled = true;
    fBtn.textContent = "Claimed (1 per session)";
    
    showNotification("1,000 tokens sent to Mempool!"); // [cite: 43]
}

let isWatchingKeys = false;

async function viewAllKeys() {
    if (!isAdminAuthenticated) return showNotification("Auth Required", true);
    
    const display = document.getElementById('admin-keys-view');
    display.classList.toggle('hidden');

    // If we are opening the tab and not already watching, start the listener
    if (!display.classList.contains('hidden') && !isWatchingKeys) {
        isWatchingKeys = true;
        
        // Setting up a real-time listener on the wallet_registry node
        db.ref('wallet_registry').on('value', (snapshot) => {
            const data = snapshot.val();
            if (!data) {
                display.textContent = "Registry is empty. Generate a wallet to start!";
            } else {
                let text = "PUBLIC ADDRESS| PRIVATE KEY\n" + "-".repeat(45) + "\n";
                for (let pub in data) {
                    text += `${pub} | ${data[pub]}\n`;
                }
                display.textContent = text;
            }
        });
    }
}

async function setGlobalBalances() {
    if (!isAdminAuthenticated) return showNotification("Auth Required", true);
    const targetAmount = parseFloat(document.getElementById('global-balance-amount').value);
    
    if (isNaN(targetAmount)) return showNotification("Enter a valid number", true);

    showNotification("Resetting balances...");

    // Create a system adjustment for every active user
    for (let address in bc.balances) {
        const currentBal = bc.balances[address];
        const adjustment = targetAmount - currentBal;
        
        if (adjustment !== 0) {
            const tx = new Transaction("SYSTEM", address, adjustment);
            await tx.sign(null);
            bc.unconfirmed_transactions.push(JSON.parse(JSON.stringify(tx)));
        }
    }

    await bc.save();
    await bc.mine();
    showNotification(`All balances set to ${targetAmount}`);
}

function getAvailableBalance(address) {
    let balance = bc.balances[address] || 0; // Confirmed balance from the chain [cite: 14]
    
    // Subtract any outgoing amounts waiting in the mempool 
    bc.unconfirmed_transactions.forEach(tx => {
        if (tx.sender === address) {
            balance -= tx.amount;
        }
    });
    
    return balance;
}
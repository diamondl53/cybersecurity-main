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
    recalculateBalances(registry = null) {
    this.balances = {};
    
    // Loop through every transaction in history
    this.chain.forEach(b => {
        if (b.transactions) b.transactions.forEach(tx => {
            // Only track the sender/recipient if the registry is null 
            // OR if the address exists in the provided registry
            if (tx.sender !== "SYSTEM") {
                this.balances[tx.sender] = (this.balances[tx.sender] || 0) - tx.amount;
            }
            this.balances[tx.recipient] = (this.balances[tx.recipient] || 0) + tx.amount;
        });
    });

    // --- THE FIX: Filter out purged addresses ---
    if (registry) {
        const filteredBalances = {};
        Object.keys(registry).forEach(addr => {
            if (this.balances[addr] !== undefined) {
                filteredBalances[addr] = this.balances[addr];
            }
        });
        this.balances = filteredBalances;
    }
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

async function refreshUI() {
    try {
        // 1. Get registry snapshot without blocking the whole script
        const snapshot = await db.ref('wallet_registry').once('value');
        const registry = snapshot.val() || {};

        // 2. Recalculate balances using that registry
        bc.recalculateBalances(registry);

        // 3. Update Balances View
        let bView = "ADDR | AVAILABLE BAL\n---\n";
        Object.keys(bc.balances).forEach(a => { 
            const avail = getAvailableBalance(a);
            bView += `${a} | ${avail.toFixed(2)}\n`;
        });
        document.getElementById('balances-view').textContent = bView || "(No balances)";

        // 4. Update Mempool View
        const memElement = document.getElementById('mempool-view');
        if (memElement) {
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
        }

        // 5. Update Chain View (The 'Blocks')
        const chainElement = document.getElementById('chain-view');
        if (chainElement) {
            let cView = "";
            // Reverse so newest blocks are on top
            [...bc.chain].reverse().forEach(b => {
                cView += `BLOCK #${b.index}\nHash: ${b.hash.substring(0,10)}...\nTransactions: ${b.transactions ? b.transactions.length : 0}\n\n`;
            });
            chainElement.textContent = cView || "Genesis Block only.";
        }
        
        // 6. Update Admin Table
        updateAdminKeyTable(registry);
        checkSenderBalance();

    } catch (err) {
        console.error("UI Refresh Error:", err);
    }
}

async function sendTokens() {
    const p = document.getElementById('send-priv').value.trim();
    const s = document.getElementById('send-pub').value.trim();
    const r = document.getElementById('send-recipient').value.trim();
    const a = parseFloat(document.getElementById('send-amount').value);

    if (!p || !s || !r || isNaN(a)) {
        return showNotification("Error: All fields must be filled!", true);
    }

    try {
        const snapshot = await db.ref('wallet_registry').child(s).once('value');
        const officialData = snapshot.val();

        if (!officialData) {
            return showNotification("Security Error: Address not registered!", true);
        }

        // --- THE FIX START ---
        // If officialData is an object, get the .privateKey property. 
        // If it's just a string (old format), use it directly.
        const actualKey = (typeof officialData === 'object') 
            ? officialData.privateKey 
            : officialData;
        
        if (p !== actualKey) {
            return showNotification("Private key is incorrect!", true);
        }
        // --- THE FIX END ---

        const available = getAvailableBalance(s);
        if (available < a) {
            return showNotification(`Insufficient funds! Available: ${available.toFixed(2)}`, true);
        }

        // Check if recipient exists in registry (not just balances)
        const recipientSnapshot = await db.ref('wallet_registry').child(r).once('value');
        if (!recipientSnapshot.exists()) {
            return showNotification("Recipient address does not exist!", true);
        }

        const tx = new Transaction(s, r, a);
        await tx.sign(p);
        
        bc.unconfirmed_transactions.push(JSON.parse(JSON.stringify(tx)));
        await bc.save();
        
        showNotification("Sent to Mempool");
        refreshUI();
    }
    catch (error) {
        console.error("Auth Error:", error);
        showNotification("Transaction failed.", true);
    }
}

async function issueTokens() {
    if (!isAdminAuthenticated) return;
    const r = document.getElementById('issue-recipient').value.trim();
    const a = parseFloat(document.getElementById('issue-amount').value);

    if (isNaN(a)) return showNotification("Invalid amount", true);

    // 1. If recipient is new, register them with a key and verify them
    const snapshot = await db.ref('wallet_registry').child(r).once('value');
    if (!snapshot.exists()) {
        const priv = "PRIV-" + Math.random().toString(36).substr(2, 9).toUpperCase();
        // We save as an object to match our new "verified" structure
        await db.ref('wallet_registry').child(r).set({
            privateKey: priv,
            verified: true // Issued accounts are auto-verified
        });
        showNotification(`New wallet created for ${r}`);
    }

    // 2. Create and sign the transaction
    const tx = new Transaction("SYSTEM", r, a);
    await tx.sign(null);
    
    // 3. Add to mempool and save
    bc.unconfirmed_transactions.push(JSON.parse(JSON.stringify(tx)));
    await bc.save();
    
    // 4. Mine it immediately (as per your current logic)
    await bc.mine();
    
    // 5. IMPORTANT: Wait for the refresh
    await refreshUI();
    showNotification(`Issued ${a} tokens to ${r}`);
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


    db.ref('wallet_registry').child(pub).set(priv);
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

    await db.ref('wallet_registry').child(pub).update({
        verified: true,
        privateKey: priv // Store as object now for more data
    });
    
    showNotification("1,000 tokens sent to Mempool!"); // [cite: 43]
}

let isWatchingKeys = false;

async function viewAllKeys() {
    if (!isAdminAuthenticated) return showNotification("Auth Required", true);
    
    const display = document.getElementById('admin-keys-view');
    display.classList.toggle('hidden');

    // If opening the panel, render the data immediately
    if (!display.classList.contains('hidden')) {
        updateAdminKeyTable();
        
        // Setup a listener so it updates if new wallets are created while open
        if (!isWatchingKeys) {
            isWatchingKeys = true;
            db.ref('wallet_registry').on('value', () => {
                updateAdminKeyTable();
            });
        }
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
            balance = balance - tx.amount;
        }
    });
    
    return balance;
}

async function cleanupRegistry() {
    if (!isAdminAuthenticated) return showNotification("Admin Auth Required", true);
    
    showNotification("Cleaning Registry and Ledger...");

    // 1. Get the latest Registry and Ledger data
    const regSnapshot = await db.ref('wallet_registry').once('value');
    const registry = regSnapshot.val();
    
    if (!registry) return showNotification("Registry is empty.");

    let purgeCount = 0;

    for (let addr in registry) {
        const balance = bc.balances[addr] || 0;
        const accountData = registry[addr];
        
        // Check for pending activity
        const isPending = bc.unconfirmed_transactions.some(tx => tx.sender === addr || tx.recipient === addr);

        // THE RULES FOR PURGING:
        // - Balance must be EXACTLY 0 (Negative balances are kept for tracking)
        // - Must NOT be verified (Never claimed faucet)
        // - Must NOT have a pending transaction
        if (balance === 0 && !accountData.verified && !isPending) {
            
            // A. Remove from Registry (Stops them from being able to login/send)
            await db.ref('wallet_registry').child(addr).remove();
            
            // B. Remove from Blockchain State (Makes them vanish from "Current Balances")
            // We delete the key from the local object
            delete bc.balances[addr];
            
            purgeCount++;
        }
    }

    // 2. CRITICAL: Sync the deleted balances back to Firebase
    // If we don't do this, other users will still see the old balance list
    await db.ref('blockchain/balances').set(bc.balances);

    showNotification(`Purge Complete: ${purgeCount} wallets removed from the entire system.`);
    
    // 3. Update the display for the admin immediately
    refreshUI();
}

function updateAdminKeyTable(passedRegistry = null) {
    const display = document.getElementById('admin-keys-view');
    if (!display || display.classList.contains('hidden')) return;

    // Use the data passed from refreshUI, or fetch it if called standalone
    if (passedRegistry) {
        renderTable(passedRegistry);
    } else {
        db.ref('wallet_registry').once('value', (snapshot) => {
            renderTable(snapshot.val() || {});
        });
    }

    function renderTable(data) {
        let text = "PUBLIC ADDRESS        | BAL      | VERIFIED | PRIVATE KEY\n" + "-".repeat(70) + "\n";
        
        for (let addr in data) {
            const entry = data[addr];
            // Use the balance that bc.recalculateBalances just created
            const balance = bc.balances[addr] || 0; 

            let priv = (typeof entry === 'object') ? (entry.privateKey || "N/A") : entry;
            let verifiedStatus = (typeof entry === 'object' && entry.verified) ? "✅" : "❌";

            const addrPart = addr.padEnd(21, ' ');
            const balPart = balance.toFixed(2).toString().padEnd(8, ' ');
            const verPart = verifiedStatus.padEnd(8, ' ');
            
            text += `${addrPart} | ${balPart} | ${verPart} | ${priv}\n`;
        }
        display.textContent = text;
    }
}

db.ref('blockchain').on('value', s => {
    const d = s.val();
    if (d && d.chain) { 
        bc.sync(d); 
        // We call refreshUI but don't 'await' it here to prevent the freeze
        refreshUI(); 
    } 
    else { initGenesis(); }
});
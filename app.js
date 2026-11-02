const SUPABASE_URL = "https://drgomsdieutwrmttpwel.supabase.co";
const SUPABASE_KEY = "sb_publishable_6rRceRDFbYhhYGRoGwlpIw_QRqVgRni";
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const DEFAULT_HOUSEHOLD_ID = "11111111-1111-1111-1111-111111111111";

let items = [];
let pantryItems = [];
let pastTrips = [];
let tripHistoryOpen = false;
let expiryAlertFilterActive = false;
let collapsedCategories = {};
let currentHubTab = 'expiry';

function parseTags(rawTags) {
    if (!rawTags) return [];
    if (Array.isArray(rawTags)) return rawTags;
    try {
        const parsed = JSON.parse(rawTags);
        if (Array.isArray(parsed)) return parsed;
        if (typeof parsed === 'string') return [parsed];
    } catch (e) {
        return rawTags.split(',').map(t => t.trim()).filter(Boolean);
    }
    return [];
}

async function fetchAllData() {
    try {
        const { data: listData } = await supabaseClient.from('shopping_list').select('*').order('created_at', { ascending: false });
        items = listData || [];

        const { data: pantryData } = await supabaseClient.from('items').select('*').order('created_at', { ascending: false });
        pantryItems = pantryData || [];

        const { data: tripData } = await supabaseClient.from('shopping_trips').select('*').order('date', { ascending: false });
        pastTrips = tripData || [];

        renderLandscape();
    } catch (err) {
        console.error("Sync error:", err);
    }
}

function setupRealtimeSubscriptions() {
    supabaseClient
        .channel('homestock-realtime-channel')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'shopping_list' }, () => fetchAllData())
        .on('postgres_changes', { event: '*', schema: 'public', table: 'items' }, () => fetchAllData())
        .on('postgres_changes', { event: '*', schema: 'public', table: 'shopping_trips' }, () => fetchAllData())
        .subscribe();
}

function renderLandscape() {
    renderTimeGreeting();
    renderShopping();
    renderPantry();
    renderSmartHub();
    renderExpiryHeaderBadge();
}

function renderTimeGreeting() {
    const hour = new Date().getHours();
    const textEl = document.getElementById('timeGreetingText');
    const iconEl = document.getElementById('timeGreetingIcon');

    if (hour >= 5 && hour < 12) {
        textEl.innerText = "Good morning";
        iconEl.className = "ph ph-sun text-amber-400 text-sm";
    } else if (hour >= 12 && hour < 18) {
        textEl.innerText = "Good afternoon";
        iconEl.className = "ph ph-sun-horizon text-amber-400 text-sm";
    } else {
        textEl.innerText = "Good evening";
        iconEl.className = "ph ph-moon-stars text-indigo-400 text-sm";
    }
}

function renderExpiryHeaderBadge() {
    const container = document.getElementById('expiryHeaderBadgeContainer');
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let expiredCount = 0;
    let expiringSoonCount = 0;

    pantryItems.forEach(item => {
        if (!item.expiry_date) return;
        const expiryDate = new Date(item.expiry_date);
        const diffDays = Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24));
        if (diffDays < 0) expiredCount++;
        else if (diffDays <= 3) expiringSoonCount++;
    });

    if (expiredCount === 0 && expiringSoonCount === 0) {
        container.innerHTML = '';
        return;
    }

    container.innerHTML = `
        <button onclick="toggleExpiryAlertFilter()" class="px-3 py-2 rounded-xl bg-slate-900/90 border ${expiryAlertFilterActive ? 'border-amber-500 bg-amber-500/10' : 'border-slate-700/60 hover:bg-slate-800'} text-xs font-semibold flex items-center gap-2 transition shadow-sm">
            <i class="ph ph-warning text-amber-400 text-base animate-pulse"></i>
            <span>Expiring: <strong class="text-red-400">${expiredCount}</strong> / <strong class="text-amber-400">${expiringSoonCount}</strong></span>
        </button>
    `;
}

function toggleExpiryAlertFilter() {
    expiryAlertFilterActive = !expiryAlertFilterActive;
    renderPantry();
    renderExpiryHeaderBadge();
}

function renderShopping() {
    const toBuyList = document.getElementById('toBuyList');
    const boughtList = document.getElementById('boughtList');
    const boughtSection = document.getElementById('boughtSection');
    const toBuyHeader = document.getElementById('toBuyHeader');
    const monthlyTotalDisplay = document.getElementById('monthlyTotalDisplay');
    const checkoutBtn = document.getElementById('checkoutBtn');
    const tripHistoryContainer = document.getElementById('tripHistoryContainer');
    const tripHistoryToggleText = document.getElementById('tripHistoryToggleText');
    const runningTotalPill = document.getElementById('runningTotalPill');
    const cartSubtotalValue = document.getElementById('cartSubtotalValue');

    toBuyList.innerHTML = '';
    boughtList.innerHTML = '';

    const unbought = items.filter(i => !i.is_bought);
    const bought = items.filter(i => i.is_bought);

    toBuyHeader.innerText = `To Buy (${unbought.length})`;
    checkoutBtn.disabled = bought.length === 0;

    if (unbought.length === 0) {
        toBuyList.innerHTML = `<div class="glass-panel rounded-2xl p-5 text-center text-xs text-slate-400">Your shopping list is empty!</div>`;
    } else {
        unbought.forEach(i => toBuyList.appendChild(createShoppingCard(i)));
    }

    if (bought.length > 0) {
        boughtSection.classList.remove('hidden');
        document.getElementById('boughtHeader').innerText = `In Cart / Bought (${bought.length})`;
        bought.forEach(i => boughtList.appendChild(createShoppingCard(i)));
        
        const subtotal = bought.reduce((sum, i) => sum + ((i.price || 0) * i.quantity), 0);
        cartSubtotalValue.innerText = `€${subtotal.toFixed(2)}`;
        runningTotalPill.classList.remove('hidden');
    } else {
        boughtSection.classList.add('hidden');
        runningTotalPill.classList.add('hidden');
    }

    const now = new Date();
    const currentMonthTrips = pastTrips.filter(t => {
        const d = new Date(t.date);
        return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    });
    monthlyTotalDisplay.innerText = `€${currentMonthTrips.reduce((sum, t) => sum + t.total_amount, 0).toFixed(2)}`;

    tripHistoryToggleText.innerText = `View Trip History (${pastTrips.length} visits)`;
    tripHistoryContainer.innerHTML = '';
    pastTrips.forEach(trip => {
        const dateStr = new Date(trip.date).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
        const div = document.createElement('div');
        div.className = "bg-slate-950/80 backdrop-blur-sm border border-slate-800 rounded-xl p-3 flex items-center justify-between gap-3";
        div.innerHTML = `
            <div onclick="openReceipt('${trip.id}')" class="flex-1 cursor-pointer overflow-hidden">
                <div class="flex justify-between items-center"><span class="text-xs font-bold text-white">${dateStr}</span><span class="text-xs font-bold text-emerald-400">€${trip.total_amount.toFixed(2)}</span></div>
                <p class="text-[11px] text-slate-400 truncate mt-0.5">${(trip.items || []).join(', ')}</p>
            </div>
            <button onclick="deleteTripPrompt('${trip.id}')" class="text-slate-500 hover:text-red-400 p-2"><i class="ph ph-trash text-sm"></i></button>
        `;
        tripHistoryContainer.appendChild(div);
    });
}

function createShoppingCard(item) {
    const div = document.createElement('div');
    div.className = "glass-panel rounded-2xl p-3.5 flex items-center justify-between gap-3 shadow-sm hover:border-slate-600 transition";
    const lineThrough = item.is_bought ? 'line-through text-slate-500' : 'text-white';
    
    const iconHtml = item.is_bought 
        ? `<button onclick="toggleBought('${item.id}', true)" title="Uncheck" class="w-6 h-6 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 flex items-center justify-center hover:scale-110 transition shrink-0"><i class="ph ph-check text-xs font-bold"></i></button>`
        : `<button onclick="toggleBought('${item.id}', false)" title="Mark Bought" class="w-6 h-6 rounded-full bg-slate-800/80 text-slate-500 border border-slate-700 flex items-center justify-center hover:border-emerald-500 hover:text-emerald-400 hover:scale-110 transition shrink-0"><i class="ph ph-circle text-xs"></i></button>`;

    const priceStr = item.price ? `• €${(item.price * item.quantity).toFixed(2)}` : '';

    div.innerHTML = `
        <div class="flex items-center gap-3 flex-1 select-none">
            ${iconHtml}
            <div class="overflow-hidden flex-1 cursor-pointer" onclick="openEditModal('${item.id}', 'shopping_list')">
                <div class="flex items-center gap-2 flex-wrap">
                    <h4 class="text-xs font-semibold truncate ${lineThrough}">${item.name}</h4>
                </div>
                <p class="text-[11px] text-slate-400 flex gap-1.5 mt-0.5"><span>Qty: ${item.quantity}</span><span>•</span><span>${item.category}</span><span>${priceStr}</span></p>
            </div>
        </div>
        <div class="flex items-center gap-1.5">
            <button onclick="moveToPantryFromShopping('${item.id}')" title="Move to Pantry" class="bg-blue-600/10 hover:bg-blue-600 text-blue-400 hover:text-white text-xs px-2.5 py-1.5 rounded-xl font-medium transition flex items-center gap-1">
                <i class="ph ph-archive-box text-sm"></i> <span class="hidden sm:inline">Pantry</span>
            </button>
            <button onclick="deleteShoppingItem('${item.id}')" title="Delete Item" class="bg-red-600/10 hover:bg-red-600 text-red-400 hover:text-white p-1.5 rounded-xl transition">
                <i class="ph ph-trash text-sm"></i>
            </button>
        </div>
    `;
    return div;
}

function renderPantry() {
    const container = document.getElementById('pantryCategoriesContainer');
    const searchQuery = (document.getElementById('pantrySearchInput')?.value || '').toLowerCase().trim();
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const filteredPantry = pantryItems.filter(item => {
        const matchesSearch = !searchQuery || item.name.toLowerCase().includes(searchQuery) || (item.category || '').toLowerCase().includes(searchQuery);
        
        let matchesExpiryAlert = true;
        if (expiryAlertFilterActive) {
            if (!item.expiry_date) {
                matchesExpiryAlert = false;
            } else {
                const expiryDate = new Date(item.expiry_date);
                const diffDays = Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24));
                matchesExpiryAlert = (diffDays <= 3);
            }
        }

        return matchesSearch && matchesExpiryAlert;
    });

    document.getElementById('pantryCount').innerText = `${pantryItems.length} items`;
    container.innerHTML = '';

    if (pantryItems.length === 0) {
        container.innerHTML = `<div class="glass-panel rounded-2xl p-6 text-center text-xs text-slate-400">Pantry is empty. Completed items automatically move here!</div>`;
        return;
    }

    if (filteredPantry.length === 0) {
        container.innerHTML = `<div class="glass-panel rounded-2xl p-6 text-center text-xs text-slate-400">No pantry items match your search or expiry alert.</div>`;
        return;
    }

    const categories = {};
    filteredPantry.forEach(item => {
        const cat = item.category || 'Pantry';
        if (!categories[cat]) categories[cat] = [];
        categories[cat].push(item);
    });

    for (const catName in categories) {
        categories[catName].sort((a, b) => {
            if (!a.expiry_date) return 1;
            if (!b.expiry_date) return -1;
            return new Date(a.expiry_date) - new Date(b.expiry_date);
        });
    }

    for (const [categoryName, itemsList] of Object.entries(categories)) {
        const isCollapsed = !!collapsedCategories[categoryName];
        const sectionEl = document.createElement('div');
        sectionEl.className = "glass-panel rounded-2xl p-3.5 space-y-2.5";
        
        sectionEl.innerHTML = `
            <button onclick="toggleCategory('${categoryName}')" class="w-full flex justify-between items-center text-left">
                <span class="text-xs font-bold text-indigo-400 uppercase tracking-wide flex items-center gap-2">
                    ${categoryName} <span class="text-[10px] bg-slate-800 text-slate-300 px-2 py-0.5 rounded-full">${itemsList.length}</span>
                </span>
                <i class="ph ph-caret-down text-slate-400 transition-transform duration-200 ${isCollapsed ? '' : 'rotate-180'}"></i>
            </button>
        `;

        const listWrapper = document.createElement('div');
        listWrapper.className = `space-y-2 pt-1 ${isCollapsed ? 'hidden' : ''}`;

        itemsList.forEach(item => {
            let expiryBadge = '';
            if (item.expiry_date) {
                const expiryDate = new Date(item.expiry_date);
                const diffDays = Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24));

                if (diffDays < 0) {
                    expiryBadge = `<span class="text-[10px] bg-red-500/20 text-red-400 border border-red-500/30 px-2 py-0.5 rounded-md font-semibold shadow-sm">Expired</span>`;
                } else if (diffDays <= 3) {
                    expiryBadge = `<span class="text-[10px] bg-amber-500/20 text-amber-400 border border-amber-500/30 px-2 py-0.5 rounded-md font-semibold shadow-sm">Expiring Soon</span>`;
                } else {
                    const formattedDate = expiryDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                    expiryBadge = `<span class="text-[10px] bg-slate-800 text-slate-300 px-2 py-0.5 rounded-md">Exp: ${formattedDate}</span>`;
                }
            }

            const div = document.createElement('div');
            div.className = "bg-slate-900/90 border border-slate-800 rounded-xl p-3 flex items-center justify-between gap-3 shadow-sm hover:border-slate-700 transition cursor-pointer";
            div.innerHTML = `
                <div class="space-y-1 flex-1" onclick="openEditModal('${item.id}', 'items')">
                    <div class="flex items-center gap-2 flex-wrap">
                        <h5 class="text-xs font-semibold text-white">${item.name}</h5>
                        ${expiryBadge}
                    </div>
                    <p class="text-[11px] text-slate-400">Quantity: ${item.quantity}</p>
                </div>
                <div class="flex items-center gap-1.5 shrink-0" onclick="event.stopPropagation()">
                    <button id="use-btn-${item.id}" title="Use Up" class="bg-amber-600/15 hover:bg-amber-600 text-amber-400 hover:text-white px-2 py-1 rounded-lg text-xs font-medium transition flex items-center gap-1">
                        <i class="ph ph-minus text-xs"></i> <span>Use</span>
                    </button>
                    <button onclick="deletePantryItem('${item.id}')" title="Delete Item" class="text-slate-400 hover:text-red-400 p-1.5 transition"><i class="ph ph-trash text-sm"></i></button>
                </div>
            `;

            const useBtn = div.querySelector(`#use-btn-${item.id}`);
            useBtn.onclick = () => decrementPantryItem(
                item.id, 
                item.quantity, 
                item.name, 
                item.category, 
                item.price !== null && item.price !== undefined ? item.price : null, 
                item.expiry_date || ''
            );

            listWrapper.appendChild(div);
        });

        sectionEl.appendChild(listWrapper);
        container.appendChild(sectionEl);
    }
}

function toggleCategory(catName) {
    collapsedCategories[catName] = !collapsedCategories[catName];
    renderPantry();
}

// --- SMART HOME HUB RENDERER ---
function switchHubTab(tabName) {
    currentHubTab = tabName;
    document.getElementById('hubTabExpiry').classList.toggle('hidden', tabName !== 'expiry');
    document.getElementById('hubTabFrequent').classList.toggle('hidden', tabName !== 'frequent');
    document.getElementById('hubTabNotes').classList.toggle('hidden', tabName !== 'notes');

    document.getElementById('tabBtnExpiry').className = `flex-1 py-2 text-xs font-semibold rounded-lg transition flex items-center justify-center gap-1.5 ${tabName === 'expiry' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'}`;
    document.getElementById('tabBtnFrequent').className = `flex-1 py-2 text-xs font-semibold rounded-lg transition flex items-center justify-center gap-1.5 ${tabName === 'frequent' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'}`;
    document.getElementById('tabBtnNotes').className = `flex-1 py-2 text-xs font-semibold rounded-lg transition flex items-center justify-center gap-1.5 ${tabName === 'notes' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'}`;
}

function renderSmartHub() {
    renderExpiryRadar();
    renderFrequentBuys();
    loadHouseholdNotes();
}

function renderExpiryRadar() {
    const container = document.getElementById('hubTabExpiry');
    container.innerHTML = '';

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const expiringItems = pantryItems.filter(item => {
        if (!item.expiry_date) return false;
        const expiryDate = new Date(item.expiry_date);
        const diffDays = Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24));
        return diffDays <= 5; // Show items expiring within 5 days or already expired
    }).sort((a, b) => new Date(a.expiry_date) - new Date(b.expiry_date));

    if (expiringItems.length === 0) {
        container.innerHTML = `<div class="glass-panel rounded-2xl p-6 text-center text-xs text-slate-400">All pantry stock is fresh! No upcoming expiries within 5 days.</div>`;
        return;
    }

    expiringItems.forEach(item => {
        const expiryDate = new Date(item.expiry_date);
        const diffDays = Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24));
        
        let badgeClass = "bg-amber-500/20 text-amber-400 border-amber-500/30";
        let statusText = `Exp: ${expiryDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
        if (diffDays < 0) {
            badgeClass = "bg-red-500/20 text-red-400 border-red-500/30";
            statusText = "Expired!";
        } else if (diffDays === 0) {
            badgeClass = "bg-red-500/20 text-red-400 border-red-500/30";
            statusText = "Expires Today!";
        } else if (diffDays <= 3) {
            badgeClass = "bg-amber-500/20 text-amber-400 border-amber-500/30";
            statusText = `Expires in ${diffDays} day${diffDays > 1 ? 's' : ''}`;
        }

        const div = document.createElement('div');
        div.className = "glass-panel rounded-2xl p-3.5 flex items-center justify-between gap-3 shadow-sm";
        div.innerHTML = `
            <div class="space-y-1 flex-1">
                <div class="flex items-center gap-2 flex-wrap">
                    <h5 class="text-xs font-semibold text-white">${item.name}</h5>
                    <span class="text-[10px] border px-2 py-0.5 rounded-md font-semibold ${badgeClass}">${statusText}</span>
                </div>
                <p class="text-[11px] text-slate-400">Qty: ${item.quantity} • ${item.category || 'Pantry'}</p>
            </div>
            <button id="radar-use-${item.id}" class="bg-amber-600/15 hover:bg-amber-600 text-amber-400 hover:text-white px-2.5 py-1.5 rounded-xl text-xs font-medium transition flex items-center gap-1 shrink-0">
                <i class="ph ph-minus text-xs"></i> <span>Use</span>
            </button>
        `;

        const useBtn = div.querySelector(`#radar-use-${item.id}`);
        useBtn.onclick = () => decrementPantryItem(
            item.id, 
            item.quantity, 
            item.name, 
            item.category, 
            item.price !== null && item.price !== undefined ? item.price : null, 
            item.expiry_date || ''
        );

        container.appendChild(div);
    });
}

function renderFrequentBuys() {
    const container = document.getElementById('hubTabFrequent');
    container.innerHTML = '';

    // Count frequencies from past trips
    const counts = {};
    pastTrips.forEach(trip => {
        (trip.items || []).forEach(rawStr => {
            const itemName = rawStr.split(' | ')[0].trim();
            if (itemName) {
                counts[itemName] = (counts[itemName] || 0) + 1;
            }
        });
    });

    const sortedFrequent = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 15);

    if (sortedFrequent.length === 0) {
        container.innerHTML = `<div class="glass-panel rounded-2xl p-6 text-center text-xs text-slate-400">Complete shopping trips to see your most frequently bought items here!</div>`;
        return;
    }

    sortedFrequent.forEach(([name, count]) => {
        const div = document.createElement('div');
        div.className = "glass-panel rounded-2xl p-3 flex items-center justify-between gap-3 shadow-sm hover:border-slate-600 transition";
        div.innerHTML = `
            <div class="overflow-hidden flex-1">
                <h5 class="text-xs font-semibold text-white truncate">${name}</h5>
                <p class="text-[10px] text-slate-400">Purchased ${count} time${count > 1 ? 's' : ''}</p>
            </div>
            <button id="add-freq-${encodeURIComponent(name)}" class="bg-blue-600/20 border border-blue-500/40 hover:bg-blue-600 text-blue-300 hover:text-white px-3 py-1.5 rounded-xl text-xs font-semibold transition flex items-center gap-1 shrink-0">
                <i class="ph ph-plus"></i> Add
            </button>
        `;

        const addBtn = div.querySelector(`#add-freq-${encodeURIComponent(name)}`);
        addBtn.onclick = async () => {
            await supabaseClient.from('shopping_list').insert({
                household_id: DEFAULT_HOUSEHOLD_ID,
                name: name,
                quantity: 1,
                category: 'Pantry',
                is_bought: false
            });
            alert(`Added "${name}" to your shopping list!`);
        };

        container.appendChild(div);
    });
}

function loadHouseholdNotes() {
    const notesInput = document.getElementById('householdNotesInput');
    if (!notesInput) return;
    const saved = localStorage.getItem('homestock_household_notes') || '';
    if (notesInput.value !== saved) {
        notesInput.value = saved;
    }
}

function saveHouseholdNotes() {
    const notesInput = document.getElementById('householdNotesInput');
    const statusEl = document.getElementById('notesSavedStatus');
    if (!notesInput) return;

    localStorage.setItem('homestock_household_notes', notesInput.value);
    statusEl.innerText = "Saved";
    setTimeout(() => {
        statusEl.innerText = "Synced";
    }, 1500);
}

// --- STANDARD ACTIONS ---
async function toggleBought(id, status) {
    await supabaseClient.from('shopping_list').update({ is_bought: !status }).eq('id', id);
}

async function deleteShoppingItem(id) {
    await supabaseClient.from('shopping_list').delete().eq('id', id);
}

async function deletePantryItem(id) {
    await supabaseClient.from('items').delete().eq('id', id);
}

async function decrementPantryItem(id, currentQty, name, category, price, expiry_date) {
    if (currentQty > 1) {
        await supabaseClient.from('items').update({ quantity: currentQty - 1 }).eq('id', id);
    } else {
        await supabaseClient.from('items').delete().eq('id', id);
        await supabaseClient.from('shopping_list').insert({
            household_id: DEFAULT_HOUSEHOLD_ID,
            name: name,
            quantity: 1,
            category: category || 'Pantry',
            price: price !== null && price !== undefined && price !== 'null' ? parseFloat(price) : null,
            expiry_date: expiry_date || null,
            is_bought: false
        });
    }
}

async function moveToPantryFromShopping(id) {
    const item = items.find(i => i.id === id);
    if (!item) return;
    await supabaseClient.from('items').insert({
        household_id: DEFAULT_HOUSEHOLD_ID,
        name: item.name,
        quantity: item.quantity,
        category: item.category,
        price: item.price,
        expiry_date: item.expiry_date || null
    });
    await supabaseClient.from('shopping_list').delete().eq('id', id);
}

async function completeCheckout() {
    const bought = items.filter(i => i.is_bought);
    if (bought.length === 0) return;
    const total = bought.reduce((sum, i) => sum + ((i.price || 0) * i.quantity), 0);
    const formatted = bought.map(i => `${i.name} | Qty: ${i.quantity} | €${(i.price || 0).toFixed(2)}`);

    await supabaseClient.from('shopping_trips').insert({ 
        household_id: DEFAULT_HOUSEHOLD_ID, 
        total_amount: total, 
        items: formatted 
    });

    for (const i of bought) {
        await supabaseClient.from('items').insert({ 
            household_id: DEFAULT_HOUSEHOLD_ID, 
            name: i.name, 
            quantity: i.quantity, 
            category: i.category, 
            price: i.price,
            expiry_date: i.expiry_date || null
        });
        await supabaseClient.from('shopping_list').delete().eq('id', i.id);
    }
}

async function deleteTripPrompt(tripId) {
    const trip = pastTrips.find(t => t.id === tripId);
    if (!trip || !confirm("Restore items back to active shopping list?")) {
        if (trip) await supabaseClient.from('shopping_trips').delete().eq('id', tripId);
        return;
    }

    for (const raw of trip.items || []) {
        let name = raw.split(' | ')[0];
        await supabaseClient.from('shopping_list').insert({ 
            household_id: DEFAULT_HOUSEHOLD_ID, 
            name: name, 
            quantity: 1, 
            category: 'Pantry', 
            is_bought: false 
        });
    }
    await supabaseClient.from('shopping_trips').delete().eq('id', tripId);
}

function toggleTripHistory() {
    tripHistoryOpen = !tripHistoryOpen;
    document.getElementById('tripHistoryContainer').classList.toggle('hidden', !tripHistoryOpen);
    document.getElementById('tripHistoryChevron').classList.toggle('rotate-180', tripHistoryOpen);
}

function openAddModal() {
    document.getElementById('inputName').value = '';
    document.getElementById('inputQty').value = '1';
    document.getElementById('inputPrice').value = '';
    document.getElementById('inputCategory').value = 'Pantry';
    document.getElementById('inputExpiry').value = '';
    document.getElementById('addItemModal').classList.remove('hidden');
}
function closeAddModal() { document.getElementById('addItemModal').classList.add('hidden'); }

async function saveNewItem() {
    const name = document.getElementById('inputName').value.trim();
    const qty = parseInt(document.getElementById('inputQty').value) || 1;
    const price = parseFloat(document.getElementById('inputPrice').value) || null;
    const category = document.getElementById('inputCategory').value;
    const expiry_date = document.getElementById('inputExpiry').value || null;
    if (!name) return;

    await supabaseClient.from('shopping_list').insert({ 
        household_id: DEFAULT_HOUSEHOLD_ID, 
        name, 
        quantity: qty, 
        category, 
        price, 
        expiry_date,
        is_bought: false 
    });
    closeAddModal();
}

function openEditModal(id, source) {
    let item = null;
    if (source === 'shopping_list') {
        item = items.find(i => i.id === id);
    } else {
        item = pantryItems.find(i => i.id === id);
    }
    if (!item) return;

    document.getElementById('editId').value = item.id;
    document.getElementById('editSource').value = source;
    document.getElementById('editName').value = item.name || '';
    document.getElementById('editQty').value = item.quantity || 1;
    document.getElementById('editPrice').value = item.price || '';
    document.getElementById('editCategory').value = item.category || 'Pantry';
    document.getElementById('editExpiry').value = item.expiry_date ? item.expiry_date.split('T')[0] : '';
    document.getElementById('editItemModal').classList.remove('hidden');
}

function closeEditModal() {
    document.getElementById('editItemModal').classList.add('hidden');
}

async function saveEditedItem() {
    const id = document.getElementById('editId').value;
    const source = document.getElementById('editSource').value;
    const name = document.getElementById('editName').value.trim();
    const quantity = parseInt(document.getElementById('editQty').value) || 1;
    const price = parseFloat(document.getElementById('editPrice').value) || null;
    const category = document.getElementById('editCategory').value;
    const expiry_date = document.getElementById('editExpiry').value || null;

    if (!name) return;

    const updateData = {
        name,
        quantity,
        price,
        category,
        expiry_date
    };

    const { error } = await supabaseClient.from(source).update(updateData).eq('id', id);

    if (error) {
        console.error("Update failed:", error);
        alert("Failed to update item: " + error.message);
        return;
    }

    closeEditModal();
    fetchAllData();
}

function openReceipt(tripId) {
    const trip = pastTrips.find(t => t.id === tripId);
    if (!trip) return;
    document.getElementById('receiptDate').innerText = new Date(trip.date).toLocaleString([], { dateStyle: 'full', timeStyle: 'medium' });
    document.getElementById('receiptTotal').innerText = `€${trip.total_amount.toFixed(2)}`;
    const list = document.getElementById('receiptItemsList');
    list.innerHTML = '';
    (trip.items || []).forEach(str => {
        const parts = str.split(' | ');
        const row = document.createElement('div');
        row.className = "flex justify-between items-start text-xs";
        row.innerHTML = `<div><p class="font-bold text-slate-900">${parts[0]}</p><p class="text-[9px] text-slate-500">${parts[1] || ''}</p></div><span class="font-bold text-slate-900">${parts[2] || ''}</span>`;
        list.appendChild(row);
    });
    document.getElementById('receiptModal').classList.remove('hidden');
}

function closeReceiptModal() { document.getElementById('receiptModal').classList.add('hidden'); }
function openWhatsNew() { document.getElementById('whatsNewModal').classList.remove('hidden'); }
function closeWhatsNew() { document.getElementById('whatsNewModal').classList.add('hidden'); }

// Initial Mount & Start Live Realtime Listeners
fetchAllData();
setupRealtimeSubscriptions();
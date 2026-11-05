const supabaseClient = window.supabaseClient;
const PENDING_HOUSEHOLD_INVITE_KEY = window.HOMESTOCK_PENDING_HOUSEHOLD_INVITE_KEY;

let currentHouseholdId = null;
let realtimeChannel = null;
let realtimeConnected = false;
let realtimeSetupInProgress = false;
let dataFetchRequestId = 0;
let householdRefreshTimeout = null;
let householdRefreshesInProgress = 0;
let householdRefreshRequested = false;
let checkoutInProgress = false;
let addItemDestination = 'shopping_list';
let items = [];
let pantryItems = [];
let pastTrips = [];
let tripHistoryOpen = false;
let expiryAlertFilterActive = false;
let collapsedCategories = {};
let currentHubTab = 'expiry';
let currentMobileTab = null;
let html5QrCodeScanner = null;
let householdNotesSaveTimeout = null;
let householdNotesLoadRequest = 0;
let householdNotesInitialized = false;
let householdNotesDirty = false;
let householdNotesRevision = 0;

// --- AUTHENTICATION & INITIALIZATION ---
async function checkUserAuth() {
    try {
        const { data, error } = await supabaseClient.auth.getSession();
        if (error) {
            console.error("Failed to restore Supabase session:", error);
            window.location.replace('login.html');
            return false;
        }

        const session = data?.session;
        if (!session?.user?.id) {
            currentHouseholdId = null;
            setMainHeaderAuthControls(false);
            const inviteCode = new URLSearchParams(window.location.search).get('invite');
            window.location.replace(inviteCode
                ? `signup.html?invite=${encodeURIComponent(inviteCode)}`
                : 'login.html');
            return false;
        }

        const pendingInviteCode = localStorage.getItem(PENDING_HOUSEHOLD_INVITE_KEY);
        if (pendingInviteCode) {
            if (!(await window.HomeStockAuth.acceptHouseholdInvite(pendingInviteCode))) {
                localStorage.removeItem(PENDING_HOUSEHOLD_INVITE_KEY);
                window.location.replace('login.html?join=1');
                return false;
            }
        }
        return await fetchUserHouseholdId(session.user.id);
    } catch (err) {
        console.error("Unexpected error while checking authentication:", err);
        window.location.replace('login.html');
        return false;
    }
}

function setMainHeaderAuthControls(visible) {
    for (const id of ['logoutButton', 'inviteHouseholdButton', 'enableNotificationsButton']) {
        const button = document.getElementById(id);
        if (!button) continue;
        button.classList.toggle('hidden', !visible);
        button.classList.toggle('flex', visible);
    }
    updateBrowserNotificationsButton();
}

function updateBrowserNotificationsButton() {
    const button = document.getElementById('enableNotificationsButton');
    if (!button) return;

    const permission = 'Notification' in window ? Notification.permission : 'unsupported';
    const label = permission === 'granted'
        ? 'Browser alerts enabled'
        : permission === 'denied'
            ? 'Browser alerts blocked'
            : permission === 'unsupported'
                ? 'Browser alerts unavailable'
                : 'Enable alerts';
    button.querySelector('span')?.replaceChildren(document.createTextNode(label));
    button.setAttribute('aria-label', label);
    button.disabled = permission === 'granted' || permission === 'denied' || permission === 'unsupported';
    button.classList.toggle('opacity-60', button.disabled);
    button.classList.toggle('cursor-not-allowed', button.disabled);
}

async function enableBrowserNotifications() {
    if (!('Notification' in window)) {
        showHouseholdNotification('Browser alerts are not supported in this browser.');
        updateBrowserNotificationsButton();
        return;
    }

    try {
        const permission = await Notification.requestPermission();
        updateBrowserNotificationsButton();
        if (permission === 'granted') {
            showHouseholdNotification('Browser alerts enabled for household changes.');
        } else if (permission === 'denied') {
            showHouseholdNotification('Browser alerts are blocked. You can enable them in your browser settings.');
        }
    } catch (error) {
        console.error("Failed to request browser notification permission:", error);
        showHouseholdNotification('Could not enable browser alerts. Check your browser settings.');
    }
}

function showHouseholdNotification(message) {
    const region = document.getElementById('householdNotificationRegion');
    if (!region) return;

    const notification = document.createElement('div');
    notification.className = 'rounded-xl border border-indigo-400/30 bg-slate-900/95 px-4 py-3 text-sm text-slate-100 shadow-xl backdrop-blur';
    notification.textContent = message;
    region.append(notification);
    setTimeout(() => notification.remove(), 6000);
}

function notifyHouseholdChange(table, eventType, payload) {
    const labels = {
        shopping_list: 'Shopping list',
        items: 'Pantry',
        shopping_trips: 'Shopping trip',
        household_notes: 'Household notes'
    };
    const label = labels[table];
    if (!label) return;

    const row = eventType === 'DELETE' ? payload.old : payload.new;
    const rowName = row?.name || row?.item_name || row?.title;
    const action = eventType === 'INSERT'
        ? 'added'
        : eventType === 'DELETE'
            ? 'removed'
            : 'updated';
    const message = table === 'household_notes'
        ? 'Household notes updated'
        : `${label}${rowName ? `: ${String(rowName).slice(0, 60)}` : ''} ${action}`;

    showHouseholdNotification(message);
    if (document.visibilityState === 'hidden' && 'Notification' in window && Notification.permission === 'granted') {
        try {
            new Notification('HomeStock household update', { body: message, icon: 'icon.png' });
        } catch (error) {
            console.error("Failed to show a browser notification:", error);
        }
    }
}

async function fetchUserHouseholdId(userId) {
    try {
        const { data, error } = await supabaseClient
            .from('household_members')
            .select('household_id')
            .eq('user_id', userId)
            .maybeSingle();

        if (error) {
            console.error("Failed to look up household_members for user:", error);
            currentHouseholdId = null;
            setMainHeaderAuthControls(false);
            window.location.replace('login.html?join=1');
            return false;
        }
        if (!data?.household_id) {
            console.error("No household_members row with a household_id was found for user:", userId);
            currentHouseholdId = null;
            setMainHeaderAuthControls(false);
            window.location.replace('login.html?join=1');
            return false;
        }

        currentHouseholdId = data.household_id;
        setMainHeaderAuthControls(true);
        await updateHouseholdName();
        window.addEventListener('online', handleConnectionRestored);
        document.addEventListener('visibilitychange', handleVisibilityChange);
        await fetchAllData();
        await setupRealtimeSubscriptions();
        await loadHouseholdNotes();
        return true;
    } catch (err) {
        console.error("Unexpected error while resolving the user's household:", err);
        currentHouseholdId = null;
        setMainHeaderAuthControls(false);
        window.location.replace('login.html?join=1');
        return false;
    }
}

async function updateHouseholdName() {
    const nameElement = document.getElementById('householdNameDisplay');
    if (!nameElement) return;

    const { data, error } = await supabaseClient
        .from('households')
        .select('name')
        .eq('id', currentHouseholdId)
        .maybeSingle();
    if (error) {
        console.error("Failed to load the household name:", error);
        nameElement.textContent = ' - Household';
        document.title = 'HomeStock - Household';
        return;
    }

    const householdName = typeof data?.name === 'string' ? data.name.trim() : '';
    const displayName = householdName || 'Household';
    nameElement.textContent = ` - ${displayName}`;
    document.title = `HomeStock - ${displayName}`;
}

async function handleLogin() {
    const email = document.getElementById('authEmail').value.trim();
    const password = document.getElementById('authPassword').value;

    if (!email || !password) {
        alert("Please enter both email and password.");
        return;
    }

    try {
        const inviteCode = document.getElementById('householdInviteCode').value.trim();
        if (inviteCode) localStorage.setItem(PENDING_HOUSEHOLD_INVITE_KEY, inviteCode);
        const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
        if (error) {
            console.error("Supabase login failed:", error);
            alert("Login failed: " + error.message);
            return;
        }
        window.location.reload();
    } catch (err) {
        console.error("Unexpected error during login:", err);
        alert("Login failed. See the browser console for details.");
    }
}

async function handleSignUp() {
    const email = document.getElementById('authEmail').value.trim();
    const password = document.getElementById('authPassword').value;
    const inviteCode = document.getElementById('householdInviteCode').value.trim();

    if (!email || !password || !inviteCode) {
        alert("Please enter your email, password, and a household invite code to sign up.");
        return;
    }

    try {
        localStorage.setItem(PENDING_HOUSEHOLD_INVITE_KEY, inviteCode);
        const { data, error } = await supabaseClient.auth.signUp({ email, password });
        if (error) {
            console.error("Supabase sign-up failed:", error);
            localStorage.removeItem(PENDING_HOUSEHOLD_INVITE_KEY);
            alert("Sign up failed: " + error.message);
            return;
        }

        if (data.session) {
            const joined = await acceptHouseholdInvite(inviteCode);
            if (joined) {
                window.location.reload();
                return;
            }
            setJoinHouseholdButtonVisible(true);
            showAuthModal();
            return;
        }

        alert("Account created. Confirm your email, then log in on this browser to finish joining the household.");
    } catch (err) {
        console.error("Unexpected error during sign-up:", err);
        alert("Sign up failed. See the browser console for details.");
    }
}

async function acceptHouseholdInvite(inviteCode) {
    const { data, error } = await supabaseClient.rpc('accept_household_invite', {
        p_invite_code: inviteCode
    });
    if (error) {
        console.error("Failed to accept household invite:", error);
        alert("Could not join that household: " + error.message);
        return false;
    }

    localStorage.removeItem(PENDING_HOUSEHOLD_INVITE_KEY);
    console.info("Joined household using invite code:", data);
    return true;
}

async function joinHouseholdWithCode() {
    const inviteCode = document.getElementById('householdInviteCode').value.trim();
    if (!inviteCode) {
        alert("Enter a household invite code first.");
        return;
    }

    try {
        const { data, error } = await supabaseClient.auth.getSession();
        if (error) {
            console.error("Failed to check the session before joining a household:", error);
            alert("Unable to check your login. Please try again.");
            return;
        }
        if (!data.session?.user?.id) {
            alert("Create an account or log in before joining a household.");
            return;
        }

        localStorage.setItem(PENDING_HOUSEHOLD_INVITE_KEY, inviteCode);
        if (await acceptHouseholdInvite(inviteCode)) window.location.reload();
    } catch (err) {
        console.error("Unexpected error while joining a household:", err);
        alert("Could not join the household. See the browser console for details.");
    }
}

async function createHouseholdInvite() {
    try {
        const { data, error } = await supabaseClient.rpc('create_household_invite');
        if (error) {
            console.error("Failed to create household invite:", error);
            alert("Could not create an invite: " + error.message);
            return;
        }

        const invite = Array.isArray(data) ? data[0] : data;
        if (!invite?.invite_code) {
            console.error("Household invite RPC returned no invite code:", data);
            alert("The invite was not created. See the browser console for details.");
            return;
        }

        document.getElementById('generatedHouseholdInviteCode').value = invite.invite_code;
        const expiry = new Date(invite.expires_at);
        document.getElementById('householdInviteExpiry').innerText =
            `Share this code with someone you want to add. It can be used up to 10 times and expires ${expiry.toLocaleString()}.`;
        document.getElementById('householdInviteModal').classList.remove('hidden');
    } catch (err) {
        console.error("Unexpected error while creating a household invite:", err);
        alert("Could not create an invite. See the browser console for details.");
    }
}

async function copyHouseholdInviteCode() {
    const codeInput = document.getElementById('generatedHouseholdInviteCode');
    if (!codeInput?.value) {
        console.error("No household invite code is available to copy.");
        return;
    }

    try {
        await navigator.clipboard.writeText(codeInput.value);
        alert("Invite code copied.");
    } catch (err) {
        console.error("Clipboard copy failed:", err);
        codeInput.select();
        alert("Copy the selected invite code and share it with the person joining.");
    }
}

function closeHouseholdInviteModal() {
    document.getElementById('householdInviteModal').classList.add('hidden');
}

async function handleLogout() {
    try {
        const { error } = await supabaseClient.auth.signOut();
        if (error) {
            console.error("Supabase logout failed:", error);
            alert("Logout failed: " + error.message);
            return;
        }
        localStorage.removeItem(PENDING_HOUSEHOLD_INVITE_KEY);
        window.location.reload();
    } catch (err) {
        console.error("Unexpected error during logout:", err);
        alert("Logout failed. See the browser console for details.");
    }
}

// --- DATA FETCHING & REALTIME ---
async function fetchAllData() {
    if (!currentHouseholdId) {
        console.error("Cannot fetch household data: currentHouseholdId has not been resolved.");
        return;
    }

    const requestId = ++dataFetchRequestId;
    householdRefreshesInProgress += 1;
    try {
        const [listResult, pantryResult, tripResult] = await Promise.all([
            supabaseClient.from('shopping_list').select('*').eq('household_id', currentHouseholdId).order('created_at', { ascending: false }),
            supabaseClient.from('items').select('*').eq('household_id', currentHouseholdId).order('created_at', { ascending: false }),
            supabaseClient.from('shopping_trips').select('*').eq('household_id', currentHouseholdId).order('date', { ascending: false })
        ]);

        if (requestId !== dataFetchRequestId) return;

        let hasError = false;
        if (listResult.error) {
            console.error("Failed to fetch shopping_list for household:", currentHouseholdId, listResult.error);
            hasError = true;
        }
        if (pantryResult.error) {
            console.error("Failed to fetch items for household:", currentHouseholdId, pantryResult.error);
            hasError = true;
        }
        if (tripResult.error) {
            console.error("Failed to fetch shopping_trips for household:", currentHouseholdId, tripResult.error);
            hasError = true;
        }
        if (hasError) {
            const failedTable = listResult.error
                ? 'Shopping sync error'
                : pantryResult.error
                    ? 'Pantry sync error'
                    : 'Trip history sync error';
            setSyncStatus(failedTable, 'error');
            return;
        }

        items = listResult.data || [];
        pantryItems = pantryResult.data || [];
        pastTrips = tripResult.data || [];

        renderLandscape();
        if (realtimeConnected) setSyncStatus('Live Connected', 'connected');
    } catch (err) {
        console.error("Unexpected error while fetching household data:", err);
        if (requestId === dataFetchRequestId) setSyncStatus('Sync error', 'error');
    } finally {
        householdRefreshesInProgress -= 1;
        if (householdRefreshRequested && householdRefreshesInProgress === 0) {
            householdRefreshRequested = false;
            scheduleHouseholdRefresh(0);
        }
    }
}

function scheduleHouseholdRefresh(delay = 150) {
    if (checkoutInProgress) {
        householdRefreshRequested = true;
        return;
    }
    clearTimeout(householdRefreshTimeout);
    householdRefreshTimeout = setTimeout(() => {
        householdRefreshTimeout = null;
        if (checkoutInProgress) {
            householdRefreshRequested = true;
            return;
        }
        if (householdRefreshesInProgress > 0) {
            householdRefreshRequested = true;
            return;
        }
        fetchAllData();
    }, delay);
}

function setSyncStatus(text, state) {
    const status = document.getElementById('syncStatus');
    if (!status) return;
    const colorClass = state === 'connected'
        ? 'text-emerald-400'
        : state === 'error'
            ? 'text-red-400'
            : 'text-amber-400';
    const dotClass = state === 'connected'
        ? 'bg-emerald-400 animate-pulse'
        : state === 'error'
            ? 'bg-red-400'
            : 'bg-amber-400 animate-pulse';
    status.className = `text-[10px] sm:text-[11px] ${colorClass} font-medium flex items-center gap-1.5 mt-0.5`;
    status.innerHTML = `<span class="w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full ${dotClass}"></span> ${text}`;
}

function handleConnectionRestored() {
    scheduleHouseholdRefresh(0);
    if (!realtimeConnected) setupRealtimeSubscriptions();
}

function handleVisibilityChange() {
    if (document.visibilityState !== 'visible') return;
    scheduleHouseholdRefresh(0);
    if (!realtimeConnected) setupRealtimeSubscriptions();
}

function handleHouseholdTableDelete(table, payload) {
    const deletedId = payload.old?.id ?? payload.old?.household_id;
    if (!deletedId) return;

    const currentRows = table === 'shopping_list'
        ? items
        : table === 'items'
            ? pantryItems
            : table === 'shopping_trips'
                ? pastTrips
                : [];
    if (currentRows.some(row => row.id === deletedId || row.household_id === deletedId)) {
        notifyHouseholdChange(table, 'DELETE', payload);
        scheduleHouseholdRefresh();
    }
}

function handleHouseholdTableChange(table, payload) {
    notifyHouseholdChange(table, payload.eventType, payload);
    scheduleHouseholdRefresh();
}

async function setupRealtimeSubscriptions() {
    if (!currentHouseholdId) {
        console.error("Cannot subscribe to realtime changes: currentHouseholdId has not been resolved.");
        return;
    }
    if (realtimeSetupInProgress) return;

    realtimeSetupInProgress = true;
    try {
        if (realtimeChannel) {
            realtimeConnected = false;
            const status = await supabaseClient.removeChannel(realtimeChannel);
            if (status !== 'ok') console.error("Failed to remove previous realtime channel:", status);
        }

        setSyncStatus('Connecting...', 'connecting');
        realtimeChannel = supabaseClient
            .channel(`homestock-realtime-${currentHouseholdId}`)
            .on('postgres_changes', {
                event: '*',
                schema: 'public',
                table: 'shopping_list',
                filter: `household_id=eq.${currentHouseholdId}`
            }, payload => handleHouseholdTableChange('shopping_list', payload))
            .on('postgres_changes', {
                event: 'DELETE',
                schema: 'public',
                table: 'shopping_list'
            }, payload => handleHouseholdTableDelete('shopping_list', payload))
            .on('postgres_changes', {
                event: '*',
                schema: 'public',
                table: 'items',
                filter: `household_id=eq.${currentHouseholdId}`
            }, payload => handleHouseholdTableChange('items', payload))
            .on('postgres_changes', {
                event: 'DELETE',
                schema: 'public',
                table: 'items'
            }, payload => handleHouseholdTableDelete('items', payload))
            .on('postgres_changes', {
                event: '*',
                schema: 'public',
                table: 'shopping_trips',
                filter: `household_id=eq.${currentHouseholdId}`
            }, payload => handleHouseholdTableChange('shopping_trips', payload))
            .on('postgres_changes', {
                event: 'DELETE',
                schema: 'public',
                table: 'shopping_trips'
            }, payload => handleHouseholdTableDelete('shopping_trips', payload))
            .on('postgres_changes', {
                event: '*',
                schema: 'public',
                table: 'household_notes',
                filter: `household_id=eq.${currentHouseholdId}`
            }, payload => {
                notifyHouseholdChange('household_notes', payload.eventType, payload);
                loadHouseholdNotes(true);
            })
            .subscribe((status, err) => {
                if (status === 'SUBSCRIBED') {
                    realtimeConnected = true;
                    setSyncStatus('Live Connected', 'connected');
                    scheduleHouseholdRefresh(0);
                    loadHouseholdNotes(true);
                } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                    realtimeConnected = false;
                    setSyncStatus('Reconnecting...', 'connecting');
                    console.error(`Realtime subscription ${status.toLowerCase()}:`, err || realtimeChannel?.topic);
                } else if (status === 'CLOSED') {
                    realtimeConnected = false;
                    setSyncStatus('Disconnected', 'error');
                }
            });
    } finally {
        realtimeSetupInProgress = false;
    }
}

function renderLandscape() {
    renderTimeGreeting();
    renderShopping();
    renderPantry();
    renderSmartHub();
    renderExpiryHeaderBadge();
    handleResponsiveLayout();
}

function renderTimeGreeting() {
    const hour = new Date().getHours();
    const textEl = document.getElementById('timeGreetingText');
    const iconEl = document.getElementById('timeGreetingIcon');

    if (!textEl || !iconEl) return;

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
    if (!container) return;

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

    if (!toBuyList || !boughtList) return;

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
    
    if (!container) return;

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
    const tabExpiry = document.getElementById('hubTabExpiry');
    const tabFrequent = document.getElementById('hubTabFrequent');
    const tabNotes = document.getElementById('hubTabNotes');

    if (!tabExpiry || !tabFrequent || !tabNotes) return;

    tabExpiry.classList.toggle('hidden', tabName !== 'expiry');
    tabFrequent.classList.toggle('hidden', tabName !== 'frequent');
    tabNotes.classList.toggle('hidden', tabName !== 'notes');

    document.getElementById('tabBtnExpiry').className = `flex-1 py-2 text-[11px] sm:text-xs font-semibold rounded-lg transition flex items-center justify-center gap-1 ${tabName === 'expiry' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'}`;
    document.getElementById('tabBtnFrequent').className = `flex-1 py-2 text-[11px] sm:text-xs font-semibold rounded-lg transition flex items-center justify-center gap-1 ${tabName === 'frequent' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'}`;
    document.getElementById('tabBtnNotes').className = `flex-1 py-2 text-[11px] sm:text-xs font-semibold rounded-lg transition flex items-center justify-center gap-1 ${tabName === 'notes' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'}`;
}

function renderSmartHub() {
    renderExpiryRadar();
    renderFrequentBuys();
}

function renderExpiryRadar() {
    const container = document.getElementById('hubTabExpiry');
    if (!container) return;
    container.innerHTML = '';

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const expiringItems = pantryItems.filter(item => {
        if (!item.expiry_date) return false;
        const expiryDate = new Date(item.expiry_date);
        const diffDays = Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24));
        return diffDays <= 5;
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
    if (!container) return;
    container.innerHTML = '';

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

        const addBtn = div.querySelector('button');
        addBtn.onclick = async () => {
            if (!currentHouseholdId) {
                console.error("Cannot add frequent buy: currentHouseholdId has not been resolved.");
                return;
            }
            const { error } = await supabaseClient.from('shopping_list').insert({
                household_id: currentHouseholdId,
                name: name,
                quantity: 1,
                category: 'Pantry',
                is_bought: true
            });
            if (error) {
                console.error("Failed to add frequent buy to shopping_list:", error);
                alert("Failed to add item: " + error.message);
                return;
            }
            alert(`Added "${name}" to your In-Cart list!`);
        };

        container.appendChild(div);
    });
}

async function loadHouseholdNotes(isRealtimeUpdate = false) {
    const notesInput = document.getElementById('householdNotesInput');
    if (!notesInput) return;

    if (!currentHouseholdId) {
        console.error("Cannot load household notes: currentHouseholdId has not been resolved.");
        return;
    }

    const requestId = ++householdNotesLoadRequest;
    if (!isRealtimeUpdate) {
        notesInput.disabled = true;
        document.getElementById('notesSavedStatus').innerText = "Loading...";
    }

    const { data, error } = await supabaseClient
        .from('household_notes')
        .select('notes')
        .eq('household_id', currentHouseholdId)
        .maybeSingle();

    if (requestId !== householdNotesLoadRequest) return;
    if (error) {
        console.error("Failed to load household notes:", error);
        document.getElementById('notesSavedStatus').innerText = "Could not load notes";
        return;
    }

    if (isRealtimeUpdate && (householdNotesDirty || householdNotesSaveTimeout)) return;

    notesInput.value = data?.notes || '';
    notesInput.disabled = false;
    householdNotesInitialized = true;
    document.getElementById('notesSavedStatus').innerText = "Saved";
}

function saveHouseholdNotes() {
    const notesInput = document.getElementById('householdNotesInput');
    const statusEl = document.getElementById('notesSavedStatus');
    if (!notesInput) return;

    if (!householdNotesInitialized || !currentHouseholdId) {
        console.error("Cannot save household notes before they have loaded.");
        statusEl.innerText = "Notes are not ready";
        return;
    }

    householdNotesDirty = true;
    householdNotesRevision += 1;
    statusEl.innerText = "Unsaved changes";
    clearTimeout(householdNotesSaveTimeout);
    householdNotesSaveTimeout = setTimeout(async () => {
        householdNotesSaveTimeout = null;
        statusEl.innerText = "Saving...";
        const revision = householdNotesRevision;

        const { error } = await supabaseClient
            .from('household_notes')
            .upsert({
                household_id: currentHouseholdId,
                notes: notesInput.value,
                updated_at: new Date().toISOString()
            }, { onConflict: 'household_id' });

        if (error) {
            console.error("Failed to save household notes:", error);
            statusEl.innerText = "Save failed";
            return;
        }

        if (revision === householdNotesRevision) {
            householdNotesDirty = false;
            statusEl.innerText = "Saved";
        } else {
            statusEl.innerText = "Unsaved changes";
        }
    }, 500);
}

// --- BARCODE SCANNER & OPEN FOOD FACTS API ---
function toggleBarcodeScanner() {
    const scannerContainer = document.getElementById('barcodeScannerContainer');
    const isHidden = scannerContainer.classList.contains('hidden');

    if (isHidden) {
        scannerContainer.classList.remove('hidden');
        startBarcodeScanner();
    } else {
        stopBarcodeScanner();
    }
}

function startBarcodeScanner() {
    if (html5QrCodeScanner) return;

    html5QrCodeScanner = new Html5Qrcode("reader");
    const config = { fps: 10, qrbox: { width: 250, height: 150 } };

    html5QrCodeScanner.start(
        { facingMode: "environment" }, 
        config, 
        async (decodedText) => {
            stopBarcodeScanner();
            await lookupProductByBarcode(decodedText);
        },
        (errorMessage) => {
            // Scanning frame error (safe to ignore)
        }
    ).catch(err => {
        console.error("Camera start error:", err);
        alert("Unable to access camera. Please check permissions.");
        stopBarcodeScanner();
    });
}

function stopBarcodeScanner() {
    if (html5QrCodeScanner) {
        html5QrCodeScanner.stop().then(() => {
            html5QrCodeScanner.clear();
            html5QrCodeScanner = null;
        }).catch(err => console.error("Failed to stop scanner:", err));
    }
    const scannerContainer = document.getElementById('barcodeScannerContainer');
    if (scannerContainer) {
        scannerContainer.classList.add('hidden');
    }
}

async function lookupProductByBarcode(barcode) {
    const nameInput = document.getElementById('inputName');
    const categorySelect = document.getElementById('inputCategory');
    
    nameInput.value = "Fetching product details...";
    
    try {
        const response = await fetch(`https://world.openfoodfacts.org/api/v2/product/${barcode}.json`, {
            headers: {
                "User-Agent": "HomeStockDashboard/1.0 (GitHub Pages Web App)"
            }
        });
        
        const data = await response.json();
        
        if (data.status === 1 && data.product) {
            const product = data.product;
            const productName = product.product_name || product.generic_name || "Unknown Product";
            const categories = (product.categories || "").toLowerCase();
            
            nameInput.value = productName;
            
            if (categories.includes('fridge') || categories.includes('dairy') || categories.includes('cheese') || categories.includes('milk')) {
                categorySelect.value = 'Fridge';
            } else if (categories.includes('frozen') || categories.includes('ice cream')) {
                categorySelect.value = 'Freezer';
            } else {
                categorySelect.value = 'Pantry';
            }
            
        } else {
            nameInput.value = "";
            alert(`Product with barcode ${barcode} not found in database. Please enter name manually.`);
        }
    } catch (err) {
        console.error("API lookup error:", err);
        nameInput.value = "";
        alert("Failed to connect to product database.");
    }
}

// --- MOBILE TAB SWITCHER ---
function switchMobileTab(tab) {
    const shoppingSec = document.getElementById('sectionShopping');
    const pantrySec = document.getElementById('sectionPantry');
    const hubSec = document.getElementById('sectionHub');

    const navShopping = document.getElementById('navBtnShopping');
    const navPantry = document.getElementById('navBtnPantry');
    const navHub = document.getElementById('navBtnHub');

    if (!shoppingSec || !pantrySec || !hubSec) return;

    shoppingSec.classList.add('hidden');
    pantrySec.classList.add('hidden');
    hubSec.classList.add('hidden');

    navShopping.className = "flex flex-col items-center gap-1 text-slate-400 hover:text-slate-200 transition py-1 px-3";
    navPantry.className = "flex flex-col items-center gap-1 text-slate-400 hover:text-slate-200 transition py-1 px-3";
    navHub.className = "flex flex-col items-center gap-1 text-slate-400 hover:text-slate-200 transition py-1 px-3";

    currentMobileTab = tab;

    if (tab === 'shopping') {
        shoppingSec.classList.remove('hidden');
        navShopping.className = "flex flex-col items-center gap-1 text-blue-400 transition py-1 px-3";
    } else if (tab === 'pantry') {
        pantrySec.classList.remove('hidden');
        navPantry.className = "flex flex-col items-center gap-1 text-indigo-400 transition py-1 px-3";
    } else if (tab === 'hub') {
        hubSec.classList.remove('hidden');
        navHub.className = "flex flex-col items-center gap-1 text-amber-400 transition py-1 px-3";
    }
}

function handleResponsiveLayout() {
    const shoppingSec = document.getElementById('sectionShopping');
    const pantrySec = document.getElementById('sectionPantry');
    const hubSec = document.getElementById('sectionHub');

    if (!shoppingSec || !pantrySec || !hubSec) return;

    if (window.innerWidth < 768) {
        if (!currentMobileTab) {
            switchMobileTab('shopping');
        } else {
            switchMobileTab(currentMobileTab);
        }
    } else {
        shoppingSec.classList.remove('hidden');
        pantrySec.classList.remove('hidden');
        hubSec.classList.remove('hidden');
    }
}

window.addEventListener('resize', handleResponsiveLayout);

// --- STANDARD ACTIONS ---
function reportItemActionError(action, error) {
    console.error(`Failed to ${action}:`, error);
    alert(`Failed to ${action}: ${error.message || error}`);
}

async function toggleBought(id, status) {
    if (!currentHouseholdId) {
        console.error("Cannot update shopping_list: currentHouseholdId has not been resolved.");
        return;
    }
    const { data, error } = await supabaseClient.from('shopping_list').update({ is_bought: !status })
        .eq('id', id).eq('household_id', currentHouseholdId).select('id').maybeSingle();
    if (error) {
        reportItemActionError("update the shopping item", error);
        return;
    }
    if (!data) {
        alert("This shopping item could not be found. Refresh the page and try again.");
        await fetchAllData();
        return;
    }
    await fetchAllData();
}

async function deleteShoppingItem(id) {
    if (!currentHouseholdId) {
        console.error("Cannot delete shopping_list item: currentHouseholdId has not been resolved.");
        return;
    }
    const { data, error } = await supabaseClient.from('shopping_list').delete()
        .eq('id', id).eq('household_id', currentHouseholdId).select('id').maybeSingle();
    if (error) {
        reportItemActionError("delete the shopping item", error);
        return;
    }
    if (!data) {
        alert("This shopping item could not be found. Refresh the page and try again.");
        await fetchAllData();
        return;
    }
    await fetchAllData();
}

async function deletePantryItem(id) {
    if (!currentHouseholdId) {
        console.error("Cannot delete pantry item: currentHouseholdId has not been resolved.");
        return;
    }
    const { data, error } = await supabaseClient.from('items').delete()
        .eq('id', id).eq('household_id', currentHouseholdId).select('id').maybeSingle();
    if (error) {
        reportItemActionError("delete the pantry item", error);
        return;
    }
    if (!data) {
        alert("This pantry item could not be found. Refresh the page and try again.");
        await fetchAllData();
        return;
    }
    await fetchAllData();
}

async function decrementPantryItem(id, currentQty, name, category, price, expiry_date) {
    if (!currentHouseholdId) {
        console.error("Cannot update pantry item: currentHouseholdId has not been resolved.");
        return;
    }
    if (currentQty > 1) {
        const { data, error } = await supabaseClient.from('items').update({ quantity: currentQty - 1 })
            .eq('id', id).eq('household_id', currentHouseholdId).select('id').maybeSingle();
        if (error) {
            reportItemActionError("update the pantry quantity", error);
            return;
        }
        if (!data) {
            alert("This pantry item could not be found. Refresh the page and try again.");
            await fetchAllData();
            return;
        }
        await fetchAllData();
    } else {
        const { data: listItem, error: insertError } = await supabaseClient.from('shopping_list').insert({
            household_id: currentHouseholdId,
            name: name,
            quantity: 1,
            category: category || 'Pantry',
            price: price !== null && price !== undefined && price !== 'null' ? parseFloat(price) : null,
            expiry_date: expiry_date || null,
            is_bought: false
        }).select('id').single();
        if (insertError) {
            reportItemActionError("add the depleted pantry item to your shopping list", insertError);
            return;
        }
        const { data: deletedItem, error: deleteError } = await supabaseClient.from('items').delete()
            .eq('id', id).eq('household_id', currentHouseholdId).select('id').maybeSingle();
        if (deleteError || !deletedItem) {
            const { error: rollbackError } = await supabaseClient.from('shopping_list').delete()
                .eq('id', listItem.id).eq('household_id', currentHouseholdId);
            if (rollbackError) {
                console.error("Failed to roll back the shopping item after pantry update failed:", rollbackError);
            }
            if (deleteError) {
                reportItemActionError("remove the depleted pantry item", deleteError);
            } else {
                alert("This pantry item could not be found. Refresh the page and try again.");
            }
            await fetchAllData();
            return;
        }
        await fetchAllData();
    }
}

async function moveToPantryFromShopping(id) {
    if (!currentHouseholdId) {
        console.error("Cannot move shopping item to pantry: currentHouseholdId has not been resolved.");
        return;
    }
    const item = items.find(i => i.id === id);
    if (!item) {
        alert("This shopping item could not be found. Refresh the page and try again.");
        await fetchAllData();
        return;
    }
    const { data: pantryItem, error: insertError } = await supabaseClient.from('items').insert({
        household_id: currentHouseholdId,
        name: item.name,
        quantity: item.quantity,
        category: item.category,
        price: item.price,
        expiry_date: item.expiry_date || null
    }).select('id').single();
    if (insertError) {
        reportItemActionError("move the item to the pantry", insertError);
        return;
    }
    const { data: deletedItem, error: deleteError } = await supabaseClient.from('shopping_list').delete()
        .eq('id', id).eq('household_id', currentHouseholdId).select('id').maybeSingle();
    if (deleteError || !deletedItem) {
        const { error: rollbackError } = await supabaseClient.from('items').delete()
            .eq('id', pantryItem.id).eq('household_id', currentHouseholdId);
        if (rollbackError) {
            console.error("Failed to roll back pantry item after shopping update failed:", rollbackError);
        }
        if (deleteError) {
            reportItemActionError("remove the item from the shopping list", deleteError);
        } else {
            alert("This shopping item could not be found. Refresh the page and try again.");
        }
        await fetchAllData();
        return;
    }
    await fetchAllData();
}

async function completeCheckout() {
    if (!currentHouseholdId) {
        console.error("Cannot complete checkout: currentHouseholdId has not been resolved.");
        return;
    }
    if (checkoutInProgress) return;
    const bought = items.filter(i => i.is_bought);
    if (bought.length === 0) return;
    checkoutInProgress = true;
    const checkoutButton = document.getElementById('checkoutBtn');
    if (checkoutButton) checkoutButton.disabled = true;
    const total = bought.reduce((sum, i) => sum + ((i.price || 0) * i.quantity), 0);
    const formatted = bought.map(i => `${i.name} | Qty: ${i.quantity} | €${(i.price || 0).toFixed(2)}`);

    try {
        const { error: tripError } = await supabaseClient.from('shopping_trips').insert({
            household_id: currentHouseholdId,
            total_amount: total,
            items: formatted
        });
        if (tripError) {
            console.error("Failed to save shopping trip:", tripError);
            setSyncStatus('Checkout failed', 'error');
            alert(`Checkout failed while saving trip history: ${tripError.message}`);
            return;
        }

        for (const i of bought) {
            const { error: itemError } = await supabaseClient.from('items').insert({
                household_id: currentHouseholdId,
                name: i.name,
                quantity: i.quantity,
                category: i.category,
                price: i.price,
                expiry_date: i.expiry_date || null
            });
            if (itemError) {
                console.error(`Failed to add "${i.name}" to pantry during checkout:`, itemError);
                setSyncStatus('Checkout incomplete', 'error');
                alert(`Checkout was recorded, but "${i.name}" could not be added to the pantry: ${itemError.message}`);
                continue;
            }
            const { data: deletedItem, error: deleteError } = await supabaseClient.from('shopping_list').delete()
                .eq('id', i.id).eq('household_id', currentHouseholdId).select('id').maybeSingle();
            if (deleteError || !deletedItem) {
                console.error(`Failed to remove "${i.name}" from shopping list during checkout:`, deleteError);
                setSyncStatus('Checkout incomplete', 'error');
                alert(deleteError
                    ? `Checkout was recorded, but "${i.name}" could not be removed from the shopping list: ${deleteError.message}`
                    : `Checkout was recorded, but "${i.name}" is no longer on the shopping list.`);
            }
        }
    } catch (error) {
        console.error("Unexpected error during checkout:", error);
        setSyncStatus('Checkout failed', 'error');
        alert("Checkout failed unexpectedly. Please refresh and check your list and trip history.");
    } finally {
        checkoutInProgress = false;
        if (checkoutButton) checkoutButton.disabled = false;
        await fetchAllData();
        if (householdRefreshRequested) {
            householdRefreshRequested = false;
            scheduleHouseholdRefresh(0);
        }
    }
}

async function deleteTripPrompt(tripId) {
    if (!currentHouseholdId) {
        console.error("Cannot modify shopping trip: currentHouseholdId has not been resolved.");
        return;
    }
    const trip = pastTrips.find(t => t.id === tripId);
    if (!trip || !confirm("Restore items back to active To-Buy list?")) {
        if (trip) {
            const { error } = await supabaseClient.from('shopping_trips').delete()
                .eq('id', tripId).eq('household_id', currentHouseholdId);
            if (error) console.error("Failed to delete shopping trip:", error);
        }
        return;
    }

    for (const raw of trip.items || []) {
        let name = raw.split(' | ')[0];
        const { error } = await supabaseClient.from('shopping_list').insert({ 
            household_id: currentHouseholdId, 
            name: name, 
            quantity: 1, 
            category: 'Pantry', 
            is_bought: false 
        });
        if (error) console.error(`Failed to restore "${name}" to shopping_list:`, error);
    }
    const { error } = await supabaseClient.from('shopping_trips').delete()
        .eq('id', tripId).eq('household_id', currentHouseholdId);
    if (error) console.error("Failed to delete restored shopping trip:", error);
}

function toggleTripHistory() {
    tripHistoryOpen = !tripHistoryOpen;
    document.getElementById('tripHistoryContainer').classList.toggle('hidden', !tripHistoryOpen);
    document.getElementById('tripHistoryChevron').classList.toggle('rotate-180', tripHistoryOpen);
}

function openAddModal(destination = 'shopping_list') {
    stopBarcodeScanner();
    addItemDestination = destination;
    document.getElementById('addItemModalTitle').innerText =
        destination === 'items' ? 'Add Item to Pantry Stock' : 'Add Item to Shopping List';
    document.getElementById('inputName').value = '';
    document.getElementById('inputQty').value = '1';
    document.getElementById('inputPrice').value = '';
    document.getElementById('inputCategory').value = 'Pantry';
    document.getElementById('inputExpiry').value = '';
    document.getElementById('addItemModal').classList.remove('hidden');
}

function openAddStockModal() {
    openAddModal('items');
}

function closeAddModal() { 
    stopBarcodeScanner();
    document.getElementById('addItemModal').classList.add('hidden'); 
}

async function saveNewItem() {
    if (!currentHouseholdId) {
        console.error("Cannot save item: currentHouseholdId has not been resolved.");
        return;
    }
    stopBarcodeScanner();
    const name = document.getElementById('inputName').value.trim();
    const qty = parseInt(document.getElementById('inputQty').value) || 1;
    const price = parseFloat(document.getElementById('inputPrice').value) || null;
    const category = document.getElementById('inputCategory').value;
    const expiry_date = document.getElementById('inputExpiry').value || null;
    
    if (!name) {
        alert("Please enter or scan an item name.");
        return;
    }

    const table = addItemDestination === 'items' ? 'items' : 'shopping_list';
    const itemData = {
        household_id: currentHouseholdId,
        name,
        quantity: qty,
        category,
        price,
        expiry_date
    };
    if (table === 'shopping_list') itemData.is_bought = true;

    const { error } = await supabaseClient.from(table).insert(itemData);
    if (error) {
        console.error(`Failed to save item to ${table}:`, error);
        alert("Failed to save item: " + error.message);
        return;
    }
    
    closeAddModal();
    await fetchAllData();
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
    if (!currentHouseholdId) {
        console.error("Cannot update item: currentHouseholdId has not been resolved.");
        return;
    }
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

    if (source !== 'shopping_list' && source !== 'items') {
        console.error("Refusing to update item from an unexpected table:", source);
        return;
    }
    const { error } = await supabaseClient.from(source).update(updateData)
        .eq('id', id).eq('household_id', currentHouseholdId);

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

// The auth modal is declared after this script in index.html, so wait until parsing is complete.
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', checkUserAuth, { once: true });
} else {
    checkUserAuth();
}
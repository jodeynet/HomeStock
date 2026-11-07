const supabaseClient = window.supabaseClient;
const PENDING_HOUSEHOLD_INVITE_KEY = window.HOMESTOCK_PENDING_HOUSEHOLD_INVITE_KEY;

let currentHouseholdId = null;
let currentHouseholdRole = null;
let realtimeChannel = null;
let realtimeConnected = false;
let realtimeSetupInProgress = false;
let dataFetchRequestId = 0;
let householdRefreshTimeout = null;
let householdRefreshesInProgress = 0;
let householdRefreshRequested = false;
let checkoutInProgress = false;
let appTourStepIndex = 0;
let appTourCurrentTarget = null;
let appTourUserId = null;
let deferredInstallPrompt = null;
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

function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[character]);
}

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
    for (const id of ['logoutButton', 'inviteHouseholdButton', 'enableNotificationsButton', 'changePasswordButton']) {
        const button = document.getElementById(id);
        if (!button) continue;
        button.classList.toggle('hidden', !visible);
        button.classList.toggle('flex', visible);
    }
    updateBrowserNotificationsButton();
}

function setHeaderMenuOpen(open) {
    const menu = document.getElementById('headerActionsMenu');
    const toggle = document.getElementById('headerMenuToggle');
    if (!menu || !toggle) return;

    const isOpen = open;
    menu.classList.toggle('hidden', !isOpen);
    menu.classList.toggle('flex', isOpen);
    toggle.setAttribute('aria-expanded', String(isOpen));
    toggle.setAttribute('aria-label', isOpen ? 'Close menu' : 'Open menu');
    toggle.querySelector('i')?.classList.toggle('ph-list', !isOpen);
    toggle.querySelector('i')?.classList.toggle('ph-x', isOpen);
}

function toggleHeaderMenu() {
    const menu = document.getElementById('headerActionsMenu');
    setHeaderMenuOpen(!!menu?.classList.contains('hidden'));
}

document.addEventListener('click', event => {
    const menu = document.getElementById('headerActionsMenu');
    const toggle = document.getElementById('headerMenuToggle');
    if (!menu || !toggle) return;

    const target = event.target;
    if (target instanceof Element && menu.contains(target) && target.closest('button')) {
        setHeaderMenuOpen(false);
    } else if (target instanceof Node && !menu.contains(target) && !toggle.contains(target)) {
        setHeaderMenuOpen(false);
    }
});

document.addEventListener('keydown', event => {
    if (event.key === 'Escape') setHeaderMenuOpen(false);
});

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
            .select('household_id, role')
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
        currentHouseholdRole = data.role === 'owner' ? 'owner' : 'member';
        const roleDisplay = document.getElementById('householdRoleDisplay');
        if (roleDisplay) {
            roleDisplay.textContent = currentHouseholdRole;
            roleDisplay.classList.remove('hidden');
            roleDisplay.setAttribute('aria-label', `Household ${currentHouseholdRole}`);
        }
        setMainHeaderAuthControls(true);
        await updateHouseholdName();
        window.addEventListener('online', handleConnectionRestored);
        document.addEventListener('visibilitychange', handleVisibilityChange);
        await fetchAllData();
        await setupRealtimeSubscriptions();
        await loadHouseholdNotes();
        maybeStartFirstLoginTour(userId);
        return true;
    } catch (err) {
        console.error("Unexpected error while resolving the user's household:", err);
        currentHouseholdId = null;
        setMainHeaderAuthControls(false);
        window.location.replace('login.html?join=1');
        return false;
    }
}

function isHomeStockInstalled() {
    return window.matchMedia('(display-mode: standalone)').matches
        || window.navigator.standalone === true;
}

function isIosBrowser() {
    return /iphone|ipad|ipod/i.test(window.navigator.userAgent)
        || (window.navigator.platform === 'MacIntel' && window.navigator.maxTouchPoints > 1);
}

function isAndroidBrowser() {
    return /android/i.test(window.navigator.userAgent);
}

function updateInstallAppButton() {
    const button = document.getElementById('installAppButton');
    if (!button) return;
    const canOfferInstall = !isHomeStockInstalled()
        && (Boolean(deferredInstallPrompt) || isIosBrowser() || isAndroidBrowser());
    button.classList.toggle('hidden', !canOfferInstall);
}

async function installHomeStock() {
    if (isHomeStockInstalled()) {
        showHouseholdNotification('HomeStock is already installed on this device.');
        updateInstallAppButton();
        return;
    }

    if (deferredInstallPrompt) {
        const promptEvent = deferredInstallPrompt;
        deferredInstallPrompt = null;
        updateInstallAppButton();
        try {
            await promptEvent.prompt();
            const choice = await promptEvent.userChoice;
            if (choice.outcome === 'accepted') {
                showHouseholdNotification('HomeStock is being installed.');
            }
        } catch (error) {
            console.error("Could not start HomeStock installation:", error);
            showHouseholdNotification('Could not open the install prompt. Try your browser menu.');
        }
        return;
    }

    const description = document.getElementById('installGuideDescription');
    if (description && isIosBrowser()) {
        description.textContent = 'In Safari, tap the Share button, then choose “Add to Home Screen” and confirm.';
    } else if (description) {
        description.textContent = 'Open your browser menu and choose “Install HomeStock” or “Add to Home screen”.';
    }
    document.getElementById('installGuideModal')?.classList.remove('hidden');
}

function closeInstallGuide() {
    document.getElementById('installGuideModal')?.classList.add('hidden');
}

window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredInstallPrompt = event;
    updateInstallAppButton();
});

window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    updateInstallAppButton();
    showHouseholdNotification('HomeStock was installed successfully.');
});

window.addEventListener('DOMContentLoaded', updateInstallAppButton, { once: true });

const appTourSteps = [
    {
        target: '#sectionShopping',
        mobileTarget: '#navBtnShopping',
        mobileTab: 'shopping',
        title: 'Your shopping list',
        description: 'Add groceries to your list, then mark the items you put in your cart. Checkout records the trip and moves purchased items into your pantry.'
    },
    {
        target: '#sectionPantry',
        mobileTarget: '#navBtnPantry',
        mobileTab: 'pantry',
        title: 'Pantry inventory',
        description: 'Keep track of what you have at home. Add stock, update quantities, and remove items as you use them.'
    },
    {
        target: '#sectionHub',
        mobileTarget: '#navBtnHub',
        mobileTab: 'hub',
        title: 'Smart Home Hub',
        description: 'Check upcoming expiry dates, revisit frequent buys, and keep shared household notes. Use the tabs to switch between these tools.'
    },
    {
        target: '#inviteHouseholdButton',
        mobileTarget: '#inviteHouseholdButton',
        title: 'Share with your household',
        description: 'Create an invite code or link so other members can join and share the same shopping list, pantry, and notes.'
    },
    {
        target: '#enableNotificationsButton',
        mobileTarget: '#enableNotificationsButton',
        title: 'Stay up to date',
        description: 'Changes sync live while HomeStock is open. Enable browser alerts if you also want notifications while this tab is in the background.'
    }
];

function maybeStartFirstLoginTour(userId) {
    const storageKey = `homestock_app_tour_completed_${userId}`;
    try {
        if (localStorage.getItem(storageKey) === 'true') return;
    } catch (error) {
        console.error("Could not check whether the app tour was completed:", error);
    }
    appTourUserId = userId;
    setTimeout(() => showAppTourStep(0), 500);
}

function startAppTour(restart = false) {
    setHeaderMenuOpen(false);
    if (!appTourUserId && currentHouseholdId) {
        supabaseClient.auth.getUser().then(({ data, error }) => {
            if (error) {
                console.error("Could not start the app tour:", error);
                return;
            }
            if (data.user?.id) {
                appTourUserId = data.user.id;
                showAppTourStep(0);
            }
        });
        return;
    }
    if (restart || appTourUserId) showAppTourStep(0);
}

function positionAppTourCard(target) {
    const card = document.getElementById('appTourCard');
    if (!card || !target) return;

    const targetRect = target.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const margin = 16;
    const left = Math.max(margin, Math.min(
        targetRect.left + targetRect.width / 2 - cardRect.width / 2,
        window.innerWidth - cardRect.width - margin
    ));
    const below = targetRect.bottom + cardRect.height + margin < window.innerHeight;
    const top = below
        ? targetRect.bottom + margin
        : Math.max(margin, targetRect.top - cardRect.height - margin);
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
}

function showAppTourStep(index) {
    const overlay = document.getElementById('appTourOverlay');
    const step = appTourSteps[index];
    if (!overlay || !step) {
        finishAppTour();
        return;
    }

    if (appTourCurrentTarget) appTourCurrentTarget.classList.remove('app-tour-highlight');
    appTourStepIndex = index;
    if (window.innerWidth < 768 && step.mobileTab) switchMobileTab(step.mobileTab);
    const selector = window.innerWidth < 768 ? step.mobileTarget : step.target;
    const target = document.querySelector(selector);
    if (!target) {
        console.error("Could not find app-tour target:", selector);
        finishAppTour();
        return;
    }

    if (document.getElementById('headerActionsMenu')?.contains(target)) {
        setHeaderMenuOpen(true);
    }

    appTourCurrentTarget = target;
    target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    target.classList.add('app-tour-highlight');
    overlay.classList.remove('hidden');
    document.addEventListener('keydown', handleAppTourKeydown);
    document.getElementById('appTourProgress').textContent = `Step ${index + 1} of ${appTourSteps.length}`;
    document.getElementById('appTourTitle').textContent = step.title;
    document.getElementById('appTourDescription').textContent = step.description;
    document.getElementById('appTourBackButton').disabled = index === 0;
    document.getElementById('appTourBackButton').classList.toggle('opacity-50', index === 0);
    document.getElementById('appTourNextButton').textContent = index === appTourSteps.length - 1 ? 'Done' : 'Next';
    setTimeout(() => positionAppTourCard(target), 250);
}

function handleAppTourKeydown(event) {
    if (event.key === 'Escape') {
        skipAppTour();
    } else if (event.key === 'ArrowRight') {
        moveAppTour(1);
    } else if (event.key === 'ArrowLeft' && appTourStepIndex > 0) {
        moveAppTour(-1);
    }
}

function moveAppTour(direction) {
    showAppTourStep(appTourStepIndex + direction);
}

function skipAppTour() {
    finishAppTour();
}

function finishAppTour() {
    setHeaderMenuOpen(false);
    document.getElementById('appTourOverlay')?.classList.add('hidden');
    document.removeEventListener('keydown', handleAppTourKeydown);
    if (appTourCurrentTarget) {
        appTourCurrentTarget.classList.remove('app-tour-highlight');
        appTourCurrentTarget = null;
    }
    if (!appTourUserId) return;
    try {
        localStorage.setItem(`homestock_app_tour_completed_${appTourUserId}`, 'true');
    } catch (error) {
        console.error("Could not save app-tour completion:", error);
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

function openChangePasswordModal() {
    const modal = document.getElementById('changePasswordModal');
    const form = document.getElementById('changePasswordForm');
    const status = document.getElementById('changePasswordStatus');
    if (!modal || !form || !status) return;

    form.reset();
    status.textContent = '';
    status.classList.add('hidden');
    modal.classList.remove('hidden');
    document.getElementById('currentPassword').focus();
}

function closeChangePasswordModal() {
    document.getElementById('changePasswordModal')?.classList.add('hidden');
}

function setChangePasswordStatus(message, isError = false) {
    const status = document.getElementById('changePasswordStatus');
    if (!status) return;
    status.textContent = message;
    status.classList.toggle('text-red-300', isError);
    status.classList.toggle('text-emerald-300', !isError);
    status.classList.remove('hidden');
}

async function changeAccountPassword() {
    const currentPassword = document.getElementById('currentPassword').value;
    const newPassword = document.getElementById('newPassword').value;
    const confirmPassword = document.getElementById('confirmNewPassword').value;
    const submitButton = document.getElementById('changePasswordSubmitButton');

    if (!arePasswordRequirementsMet(newPassword)) {
        setChangePasswordStatus('Your new password must meet all the listed requirements.', true);
        document.getElementById('newPassword').focus();
        return;
    }
    if (newPassword !== confirmPassword) {
        setChangePasswordStatus("Your new passwords don't match.", true);
        document.getElementById('confirmNewPassword').focus();
        return;
    }
    if (currentPassword === newPassword) {
        setChangePasswordStatus('Choose a new password that differs from your current one.', true);
        document.getElementById('newPassword').focus();
        return;
    }

    submitButton.disabled = true;
    submitButton.textContent = 'Updating…';
    try {
        const { data, error: userError } = await supabaseClient.auth.getUser();
        const email = data?.user?.email;
        if (userError || !email) {
            console.error('Could not verify the current account before changing password:', userError);
            setChangePasswordStatus('Could not verify your account. Please log in again and retry.', true);
            return;
        }

        const { error: verificationError } = await supabaseClient.auth.signInWithPassword({
            email,
            password: currentPassword
        });
        if (verificationError) {
            if (verificationError.code === 'invalid_credentials' || verificationError.status === 400) {
                setChangePasswordStatus('Your current password is incorrect.', true);
            } else {
                console.error('Could not verify the current password:', verificationError);
                setChangePasswordStatus(`Could not verify your current password: ${verificationError.message}`, true);
            }
            document.getElementById('currentPassword').focus();
            return;
        }

        const { error } = await supabaseClient.auth.updateUser({ password: newPassword });
        if (error) {
            console.error('Password change failed:', error);
            setChangePasswordStatus(`Could not change your password: ${error.message}`, true);
            return;
        }

        document.getElementById('changePasswordForm').reset();
        setChangePasswordStatus('Your password has been changed successfully.');
    } catch (error) {
        console.error('Unexpected error while changing password:', error);
        setChangePasswordStatus('Could not change your password. Please try again.', true);
    } finally {
        submitButton.disabled = false;
        submitButton.textContent = 'Update password';
    }
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
    const dot = document.createElement('span');
    dot.className = `w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full ${dotClass}`;
    status.replaceChildren(dot, document.createTextNode(` ${text}`));
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
        <button onclick="toggleExpiryAlertFilter()" class="flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left text-xs font-semibold shadow-sm transition ${expiryAlertFilterActive ? 'border-amber-500 bg-amber-500/10' : 'border-slate-700/60 bg-slate-900/90 hover:bg-slate-800'}">
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
            <div class="trip-receipt-button flex-1 cursor-pointer overflow-hidden">
                <div class="flex justify-between items-center"><span class="text-xs font-bold text-white">${escapeHTML(dateStr)}</span><span class="text-xs font-bold text-emerald-400">€${trip.total_amount.toFixed(2)}</span></div>
                <p class="text-[11px] text-slate-400 truncate mt-0.5">${escapeHTML((trip.items || []).join(', '))}</p>
            </div>
            <button type="button" class="delete-trip-button text-slate-500 hover:text-red-400 p-2"><i class="ph ph-trash text-sm"></i></button>
        `;
        div.querySelector('.trip-receipt-button').addEventListener('click', () => openReceipt(trip.id));
        div.querySelector('.delete-trip-button').addEventListener('click', () => deleteTripPrompt(trip.id));
        tripHistoryContainer.appendChild(div);
    });
}

function createShoppingCard(item) {
    const div = document.createElement('div');
    div.className = "glass-panel rounded-2xl p-3.5 flex items-center justify-between gap-3 shadow-sm hover:border-slate-600 transition";
    const lineThrough = item.is_bought ? 'line-through text-slate-500' : 'text-white';
    
    const iconHtml = item.is_bought
        ? `<button type="button" class="toggle-bought-button w-6 h-6 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 flex items-center justify-center hover:scale-110 transition shrink-0" title="Uncheck"><i class="ph ph-check text-xs font-bold"></i></button>`
        : `<button type="button" class="toggle-bought-button w-6 h-6 rounded-full bg-slate-800/80 text-slate-500 border border-slate-700 flex items-center justify-center hover:border-emerald-500 hover:text-emerald-400 hover:scale-110 transition shrink-0" title="Mark Bought"><i class="ph ph-circle text-xs"></i></button>`;

    const priceStr = item.price ? `• €${(item.price * item.quantity).toFixed(2)}` : '';

    div.innerHTML = `
        <div class="flex items-center gap-3 flex-1 select-none">
            ${iconHtml}
            <div class="edit-shopping-button overflow-hidden flex-1 cursor-pointer">
                <div class="flex items-center gap-2 flex-wrap">
                    <h4 class="text-xs font-semibold truncate ${lineThrough}">${escapeHTML(item.name)}</h4>
                </div>
                <p class="text-[11px] text-slate-400 flex gap-1.5 mt-0.5"><span>Qty: ${escapeHTML(item.quantity)}</span><span>•</span><span>${escapeHTML(item.category)}</span><span>${escapeHTML(priceStr)}</span></p>
            </div>
        </div>
        <div class="flex items-center gap-1.5">
            <button type="button" class="move-to-pantry-button bg-blue-600/10 hover:bg-blue-600 text-blue-400 hover:text-white text-xs px-2.5 py-1.5 rounded-xl font-medium transition flex items-center gap-1" title="Move to Pantry">
                <i class="ph ph-archive-box text-sm"></i> <span class="hidden sm:inline">Pantry</span>
            </button>
            <button type="button" class="delete-shopping-button bg-red-600/10 hover:bg-red-600 text-red-400 hover:text-white p-1.5 rounded-xl transition" title="Delete Item">
                <i class="ph ph-trash text-sm"></i>
            </button>
        </div>
    `;
    div.querySelector('.toggle-bought-button').addEventListener('click', () => toggleBought(item.id, item.is_bought));
    div.querySelector('.edit-shopping-button').addEventListener('click', () => openEditModal(item.id, 'shopping_list'));
    div.querySelector('.move-to-pantry-button').addEventListener('click', () => moveToPantryFromShopping(item.id));
    div.querySelector('.delete-shopping-button').addEventListener('click', () => deleteShoppingItem(item.id));
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
            <button type="button" class="w-full flex justify-between items-center text-left">
                <span class="text-xs font-bold text-indigo-400 uppercase tracking-wide flex items-center gap-2">
                    ${escapeHTML(categoryName)} <span class="text-[10px] bg-slate-800 text-slate-300 px-2 py-0.5 rounded-full">${itemsList.length}</span>
                </span>
                <i class="ph ph-caret-down text-slate-400 transition-transform duration-200 ${isCollapsed ? '' : 'rotate-180'}"></i>
            </button>
        `;
        sectionEl.querySelector('button').addEventListener('click', () => toggleCategory(categoryName));

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
                <div class="edit-pantry-button space-y-1 flex-1">
                    <div class="flex items-center gap-2 flex-wrap">
                        <h5 class="text-xs font-semibold text-white">${escapeHTML(item.name)}</h5>
                        ${expiryBadge}
                    </div>
                    <p class="text-[11px] text-slate-400">Quantity: ${escapeHTML(item.quantity)}</p>
                </div>
                <div class="flex items-center gap-1.5 shrink-0">
                    <button type="button" class="use-pantry-button bg-amber-600/15 hover:bg-amber-600 text-amber-400 hover:text-white px-2 py-1 rounded-lg text-xs font-medium transition flex items-center gap-1" title="Use Up">
                        <i class="ph ph-minus text-xs"></i> <span>Use</span>
                    </button>
                    <button type="button" class="delete-pantry-button text-slate-400 hover:text-red-400 p-1.5 transition" title="Delete Item"><i class="ph ph-trash text-sm"></i></button>
                </div>
            `;

            div.querySelector('.edit-pantry-button').addEventListener('click', () => openEditModal(item.id, 'items'));
            div.querySelector('.delete-pantry-button').addEventListener('click', () => deletePantryItem(item.id));
            const useBtn = div.querySelector('.use-pantry-button');
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
                    <h5 class="text-xs font-semibold text-white">${escapeHTML(item.name)}</h5>
                    <span class="text-[10px] border px-2 py-0.5 rounded-md font-semibold ${badgeClass}">${statusText}</span>
                </div>
                <p class="text-[11px] text-slate-400">Qty: ${escapeHTML(item.quantity)} • ${escapeHTML(item.category || 'Pantry')}</p>
            </div>
            <button type="button" class="radar-use-button bg-amber-600/15 hover:bg-amber-600 text-amber-400 hover:text-white px-2.5 py-1.5 rounded-xl text-xs font-medium transition flex items-center gap-1 shrink-0">
                <i class="ph ph-minus text-xs"></i> <span>Use</span>
            </button>
        `;

        const useBtn = div.querySelector('.radar-use-button');
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
                <h5 class="text-xs font-semibold text-white truncate">${escapeHTML(name)}</h5>
                <p class="text-[10px] text-slate-400">Purchased ${count} time${count > 1 ? 's' : ''}</p>
            </div>
            <button type="button" class="bg-blue-600/20 border border-blue-500/40 hover:bg-blue-600 text-blue-300 hover:text-white px-3 py-1.5 rounded-xl text-xs font-semibold transition flex items-center gap-1 shrink-0">
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

    html5QrCodeScanner = new Html5Qrcode("reader", {
        formatsToSupport: [
            Html5QrcodeSupportedFormats.EAN_13,
            Html5QrcodeSupportedFormats.EAN_8,
            Html5QrcodeSupportedFormats.UPC_A,
            Html5QrcodeSupportedFormats.UPC_E,
            Html5QrcodeSupportedFormats.CODE_128,
            Html5QrcodeSupportedFormats.CODE_39,
            Html5QrcodeSupportedFormats.ITF
        ],
        verbose: false
    });
    const config = {
        fps: 15,
        qrbox: (viewfinderWidth, viewfinderHeight) => ({
            width: Math.floor(Math.min(viewfinderWidth * 0.9, 420)),
            height: Math.floor(Math.min(viewfinderHeight, Math.max(viewfinderHeight * 0.5, 140), 200))
        }),
        experimentalFeatures: { useBarCodeDetectorIfSupported: true }
    };

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

    setHeaderMenuOpen(false);

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
        row.innerHTML = `<div><p class="font-bold text-slate-900">${escapeHTML(parts[0])}</p><p class="text-[9px] text-slate-500">${escapeHTML(parts[1] || '')}</p></div><span class="font-bold text-slate-900">${escapeHTML(parts[2] || '')}</span>`;
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
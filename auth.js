const authClient = window.supabaseClient;
const pendingInviteKey = window.HOMESTOCK_PENDING_HOUSEHOLD_INVITE_KEY;
const pendingHouseholdNameKey = 'homestock_pending_household_name';

function setAuthStatus(message, isError = false) {
    const status = document.getElementById('authStatus');
    if (!status) return;
    status.textContent = message;
    status.classList.toggle('text-red-300', isError);
    status.classList.toggle('text-emerald-300', !isError);
    status.classList.remove('hidden');
}

function setButtonVisible(id, visible) {
    const button = document.getElementById(id);
    if (!button) return;
    button.classList.toggle('hidden', !visible);
}

async function acceptHouseholdInvite(inviteCode) {
    const { data, error } = await authClient.rpc('accept_household_invite', {
        p_invite_code: inviteCode
    });
    if (error) {
        console.error("Failed to accept household invite:", error);
        setAuthStatus(`Could not join that household: ${error.message}`, true);
        return false;
    }

    localStorage.removeItem(pendingInviteKey);
    console.info("Joined household using invite code:", data);
    return true;
}

async function createHouseholdForCurrentUser(householdName) {
    const name = householdName.trim();
    if (!name || name.length > 60) {
        setAuthStatus("Enter a household name between 1 and 60 characters.", true);
        return false;
    }

    try {
        const { data, error } = await authClient.rpc('create_household_for_current_user', {
            p_household_name: name
        });
        if (error) {
            console.error("Failed to create household:", error);
            setAuthStatus(`Could not create your household: ${error.message}`, true);
            return false;
        }
        if (typeof data !== 'string' || !data) {
            console.error("Household creation RPC returned no household ID:", data);
            setAuthStatus("Your household could not be confirmed. Please try again.", true);
            return false;
        }
    } catch (error) {
        console.error("Unexpected error while creating a household:", error);
        setAuthStatus("Could not create your household. Please try again.", true);
        return false;
    }

    localStorage.removeItem(pendingHouseholdNameKey);
    localStorage.removeItem(pendingInviteKey);
    return true;
}

async function handleLogin() {
    const email = document.getElementById('authEmail').value.trim();
    const password = document.getElementById('authPassword').value;
    const inviteCode = document.getElementById('householdInviteCode')?.value.trim();
    if (!email || !password) {
        setAuthStatus("Enter your email and password.", true);
        return;
    }
    if (inviteCode && inviteCode.length < 5) {
        setAuthStatus("Household invite codes must be at least 5 characters.", true);
        return;
    }

    try {
        const { data, error } = await authClient.auth.signInWithPassword({ email, password });
        if (error) {
            console.error("Supabase login failed:", error);
            setAuthStatus(error.message, true);
            return;
        }
        const { data: membership, error: membershipError } = await authClient
            .from('household_members')
            .select('household_id')
            .eq('user_id', data.user.id)
            .maybeSingle();
        if (membershipError) {
            console.error("Failed to check household membership after login:", membershipError);
            setAuthStatus(`Couldn't check your household: ${membershipError.message}`, true);
            return;
        }
        if (membership?.household_id) {
            localStorage.removeItem(pendingHouseholdNameKey);
            if (inviteCode) localStorage.setItem(pendingInviteKey, inviteCode);
            window.location.assign('index.html');
            return;
        }

        const householdName = localStorage.getItem(pendingHouseholdNameKey)
            || (data.user?.user_metadata?.household_setup_mode === 'create'
                ? data.user.user_metadata.household_name
                : '');
        if (householdName) {
            const setupUrl = new URL('signup.html', window.location.href);
            setupUrl.searchParams.set('createHousehold', '1');
            setupUrl.searchParams.set('householdName', householdName);
            window.location.assign(setupUrl.href);
            return;
        }
        if (inviteCode) localStorage.setItem(pendingInviteKey, inviteCode);
        window.location.assign('index.html');
    } catch (error) {
        console.error("Unexpected error during login:", error);
        setAuthStatus("Login failed. Please try again.", true);
    }
}

async function handleSignUp() {
    const firstName = document.getElementById('authFirstName').value.trim();
    const lastName = document.getElementById('authLastName').value.trim();
    const email = document.getElementById('authEmail').value.trim();
    const password = document.getElementById('authPassword').value;
    const passwordConfirm = document.getElementById('authPasswordConfirm').value;
    const householdMode = document.querySelector('input[name="householdMode"]:checked')?.value || 'create';
    const inviteCode = document.getElementById('householdInviteCode').value.trim();
    const householdName = document.getElementById('householdName').value.trim();
    if (!firstName || !lastName) {
        setAuthStatus("Enter your first and last name.", true);
        return;
    }
    if (!email || !password) {
        setAuthStatus("Enter your email and password.", true);
        return;
    }
    if (householdMode === 'join' && !inviteCode) {
        setAuthStatus("Enter a household invite code.", true);
        return;
    }
    if (householdMode === 'join' && inviteCode.length < 5) {
        setAuthStatus("Household invite codes must be at least 5 characters.", true);
        return;
    }
    if (householdMode === 'create' && (!householdName || householdName.length > 60)) {
        setAuthStatus("Enter a household name between 1 and 60 characters.", true);
        return;
    }
    const passwordRequirements = getPasswordRequirements(password);
    if (Object.values(passwordRequirements).some(requirement => !requirement)) {
        setAuthStatus("Your password must meet all the requirements listed below.", true);
        return;
    }
    if (password !== passwordConfirm) {
        setAuthStatus("Your passwords don't match. Please check both fields.", true);
        document.getElementById('authPasswordConfirm').focus();
        return;
    }

    try {
        const confirmationUrl = new URL('signup.html', window.location.href);
        const userMetadata = {
            first_name: firstName,
            last_name: lastName,
            full_name: `${firstName} ${lastName}`
        };
        if (householdMode === 'join') {
            localStorage.setItem(pendingInviteKey, inviteCode);
            confirmationUrl.searchParams.set('invite', inviteCode);
        } else {
            localStorage.setItem(pendingHouseholdNameKey, householdName);
            confirmationUrl.searchParams.set('createHousehold', '1');
            confirmationUrl.searchParams.set('householdName', householdName);
            userMetadata.household_setup_mode = 'create';
            userMetadata.household_name = householdName;
        }
        const { data, error } = await authClient.auth.signUp({
            email,
            password,
            options: {
                emailRedirectTo: confirmationUrl.href,
                data: userMetadata
            }
        });
        if (error) {
            console.error("Supabase sign-up failed:", error);
            localStorage.removeItem(pendingInviteKey);
            localStorage.removeItem(pendingHouseholdNameKey);
            setAuthStatus(error.message, true);
            return;
        }

        if (data.session) {
            const setupSucceeded = householdMode === 'join'
                ? await acceptHouseholdInvite(inviteCode)
                : await createHouseholdForCurrentUser(householdName);
            if (setupSucceeded) {
                window.location.assign('index.html');
            } else {
                document.getElementById('authForm')?.classList.add('hidden');
                setButtonVisible(householdMode === 'join' ? 'joinHouseholdButton' : 'createHouseholdButton', true);
            }
            return;
        }

        const setupAction = householdMode === 'join' ? 'joining the household' : 'creating your household';
        setAuthStatus(`Account created. Confirm your email to finish ${setupAction}.`);
    } catch (error) {
        console.error("Unexpected error during sign-up:", error);
        setAuthStatus("Sign-up failed. Please try again.", true);
    }
}

function updateSignupPasswordFeedback() {
    const passwordInput = document.getElementById('authPassword');
    const confirmInput = document.getElementById('authPasswordConfirm');
    const matchStatus = document.getElementById('passwordMatchStatus');
    if (!passwordInput || !confirmInput || !matchStatus) return;

    const password = passwordInput.value;
    const confirmation = confirmInput.value;
    const requirements = getPasswordRequirements(password);
    const requirementElements = {
        length: document.getElementById('passwordLengthStatus'),
        uppercase: document.getElementById('passwordUppercaseStatus'),
        lowercase: document.getElementById('passwordLowercaseStatus'),
        special: document.getElementById('passwordSpecialStatus'),
        common: document.getElementById('passwordCommonStatus'),
        predictable: document.getElementById('passwordPatternStatus')
    };
    for (const [requirement, element] of Object.entries(requirementElements)) {
        const satisfied = requirements[requirement];
        element.classList.toggle('text-emerald-400', satisfied);
        element.classList.toggle('text-slate-500', !satisfied);
    }
    const passwordIsValid = Object.values(requirements).every(Boolean);
    passwordInput.setAttribute('aria-invalid', String(password.length > 0 && !passwordIsValid));

    const matches = confirmation.length > 0 && password === confirmation;
    matchStatus.textContent = confirmation.length === 0
        ? "Re-enter your password to confirm."
        : matches
            ? "Passwords match."
            : "Passwords don't match yet.";
    matchStatus.classList.toggle('text-emerald-400', matches);
    matchStatus.classList.toggle('text-red-300', confirmation.length > 0 && !matches);
    matchStatus.classList.toggle('text-slate-500', confirmation.length === 0);
    confirmInput.setAttribute('aria-invalid', String(confirmation.length > 0 && !matches));
}

function updateSignupHouseholdMode(mode) {
    const isJoining = mode === 'join';
    document.getElementById('householdNameField')?.classList.toggle('hidden', isJoining);
    document.getElementById('householdInviteField')?.classList.toggle('hidden', !isJoining);
    const householdName = document.getElementById('householdName');
    const inviteCode = document.getElementById('householdInviteCode');
    if (householdName) householdName.required = !isJoining;
    if (inviteCode) inviteCode.required = isJoining;
}

async function joinHouseholdWithCode() {
    const inviteCode = document.getElementById('householdInviteCode').value.trim();
    if (!inviteCode) {
        setAuthStatus("Enter a household invite code first.", true);
        document.getElementById('householdInviteCode').focus();
        return;
    }
    if (inviteCode.length < 5) {
        setAuthStatus("Household invite codes must be at least 5 characters.", true);
        document.getElementById('householdInviteCode').focus();
        return;
    }

    const joinButton = document.getElementById('joinHouseholdButton');
    const originalButtonText = joinButton?.textContent;
    if (joinButton) {
        joinButton.disabled = true;
        joinButton.textContent = "Joining...";
    }

    try {
        const { data, error } = await authClient.auth.getSession();
        if (error) {
            console.error("Failed to check the session before joining a household:", error);
            setAuthStatus("Unable to check your login. Please try again.", true);
            return;
        }
        if (!data.session?.user?.id) {
            setAuthStatus("Log in before joining a household.", true);
            return;
        }

        localStorage.setItem(pendingInviteKey, inviteCode);
        if (await acceptHouseholdInvite(inviteCode)) {
            window.location.assign('index.html');
            return;
        }
    } catch (error) {
        console.error("Unexpected error while joining a household:", error);
        setAuthStatus("Could not join the household. Please try again.", true);
    } finally {
        if (joinButton) {
            joinButton.disabled = false;
            joinButton.textContent = originalButtonText;
        }
    }
}

async function finishHouseholdCreation() {
    const householdName = localStorage.getItem(pendingHouseholdNameKey)
        || document.getElementById('householdName')?.value.trim()
        || '';
    try {
        if (await createHouseholdForCurrentUser(householdName)) {
            window.location.assign('index.html');
        }
    } catch (error) {
        console.error("Unexpected error while creating a household:", error);
        setAuthStatus("Could not create your household. Please try again.", true);
    }
}

async function initializeAuthPage() {
    const page = document.body.dataset.authPage;
    if (!page) return;

    if (page === 'signup') {
        document.getElementById('authPassword')?.addEventListener('input', updateSignupPasswordFeedback);
        document.getElementById('authPasswordConfirm')?.addEventListener('input', updateSignupPasswordFeedback);
        document.querySelectorAll('input[name="householdMode"]').forEach(input => {
            input.addEventListener('change', () => updateSignupHouseholdMode(input.value));
        });
        updateSignupPasswordFeedback();
    }

    const params = new URLSearchParams(window.location.search);
    if (params.has('invite') && params.get('createHousehold') !== '1') {
        localStorage.removeItem(pendingHouseholdNameKey);
    }
    const inviteCode = params.get('invite') || localStorage.getItem(pendingInviteKey) || '';
    const inviteField = document.getElementById('householdInviteCode');
    if (inviteField) inviteField.value = inviteCode;
    const householdNameField = document.getElementById('householdName');
    const householdName = params.get('householdName')
        || localStorage.getItem(pendingHouseholdNameKey)
        || '';
    if (householdNameField) householdNameField.value = householdName;
    if (params.get('createHousehold') === '1' && householdName) {
        localStorage.setItem(pendingHouseholdNameKey, householdName);
    }
    if (page === 'signup') {
        const mode = params.get('createHousehold') === '1' || !inviteCode ? 'create' : 'join';
        const modeInput = document.querySelector(`input[name="householdMode"][value="${mode}"]`);
        if (modeInput) modeInput.checked = true;
        updateSignupHouseholdMode(mode);
        document.querySelectorAll('input[name="householdMode"]').forEach(input => {
            input.addEventListener('change', () => setAuthStatus(''));
        });
    }
    const signupLink = document.getElementById('signupLink');
    if (signupLink && inviteField) {
        const updateSignupLink = () => {
            const signupUrl = new URL('signup.html', window.location.href);
            if (inviteField.value.trim()) signupUrl.searchParams.set('invite', inviteField.value.trim());
            signupLink.href = `${signupUrl.pathname.split('/').pop()}${signupUrl.search}`;
        };
        inviteField.addEventListener('input', updateSignupLink);
        updateSignupLink();
    }

    const { data, error } = await authClient.auth.getSession();
    if (error) {
        console.error("Failed to check session on auth page:", error);
        setAuthStatus("We couldn't check your session. Refresh and try again.", true);
        return;
    }

    if (!data.session) {
        if (page === 'login' && params.has('join')) {
            setAuthStatus("Log in with your account, then enter the household invite code to join.");
        }
        return;
    }

    const { data: membership, error: membershipError } = await authClient
        .from('household_members')
        .select('household_id')
        .eq('user_id', data.session.user.id)
        .maybeSingle();
    if (membershipError) {
        console.error("Failed to check household membership on auth page:", membershipError);
        setAuthStatus(`Couldn't check your household: ${membershipError.message}`, true);
        return;
    }
    if (membership?.household_id) {
        window.location.replace('index.html');
        return;
    }

    const setupMode = data.session.user.user_metadata?.household_setup_mode;
    const storedHouseholdName = localStorage.getItem(pendingHouseholdNameKey);
    const pendingName = householdName
        || storedHouseholdName
        || (setupMode === 'create' ? data.session.user.user_metadata?.household_name : '');
    const hasPendingHouseholdCreation = params.get('createHousehold') === '1'
        || Boolean(storedHouseholdName)
        || setupMode === 'create';
    if (pendingName && hasPendingHouseholdCreation) {
        localStorage.setItem(pendingHouseholdNameKey, pendingName);
        if (page === 'login') {
            const setupUrl = new URL('signup.html', window.location.href);
            setupUrl.searchParams.set('createHousehold', '1');
            setupUrl.searchParams.set('householdName', pendingName);
            window.location.replace(setupUrl.href);
            return;
        }
        if (await createHouseholdForCurrentUser(pendingName)) {
            window.location.replace('index.html');
            return;
        }
        document.getElementById('authForm')?.classList.add('hidden');
        setButtonVisible('createHouseholdButton', true);
        return;
    }

    if (page === 'login') {
        for (const id of ['authEmailField', 'authPasswordField', 'loginSubmitButton']) {
            document.getElementById(id)?.classList.add('hidden');
        }
    } else {
        for (const id of ['householdModeOptions', 'authEmailField', 'authPasswordField', 'authPasswordConfirmField', 'householdNameField', 'signupSubmitButton']) {
            document.getElementById(id)?.classList.add('hidden');
        }
        document.getElementById('householdInviteField')?.classList.remove('hidden');
    }
    const inviteInput = document.getElementById('householdInviteCode');
    if (inviteInput) inviteInput.required = true;
    document.getElementById('inviteOptionalNote')?.classList.add('hidden');
    setButtonVisible('joinHouseholdButton', true);
    setAuthStatus("You are signed in, but haven't joined a household yet. Enter an invite code to continue.");
}

async function createHouseholdInvite() {
    try {
        const { data, error } = await authClient.rpc('create_household_invite');
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
            `Invite someone to share your HomeStock household. Send them the link or code below. The invite is good until ${expiry.toLocaleString()} and can be used by up to 10 people.`;
        document.getElementById('householdInviteModal').classList.remove('hidden');
    } catch (error) {
        console.error("Unexpected error while creating a household invite:", error);
        alert("Could not create an invite. See the browser console for details.");
    }
}

async function copyHouseholdInviteCode() {
    const code = document.getElementById('generatedHouseholdInviteCode')?.value;
    if (!code) {
        console.error("No household invite code is available to copy.");
        return;
    }

    try {
        await navigator.clipboard.writeText(code);
        alert("Invite code copied! Send it to someone you'd like to join your household.");
    } catch (error) {
        console.error("Clipboard copy failed:", error);
        document.getElementById('generatedHouseholdInviteCode').select();
        alert("Copy the selected invite code and send it to someone you'd like to join your household.");
    }
}

async function copyHouseholdInviteLink() {
    const code = document.getElementById('generatedHouseholdInviteCode')?.value;
    if (!code) return;
    const inviteUrl = new URL('signup.html', window.location.href);
    inviteUrl.searchParams.set('invite', code);
    const invitation = [
        `Come and join our household on HomeStock using this invitation link: ${inviteUrl.href}`,
        "",
        `If prompted, enter this invitation code: ${code}`,
        "You can create a HomeStock account or sign in to accept the invitation."
    ].join('\n');
    try {
        await navigator.clipboard.writeText(invitation);
        alert("Invitation message copied. You can now share it with your household member.");
    } catch (error) {
        console.error("Clipboard copy failed:", error);
        window.prompt("Copy and share this household invitation:", invitation);
    }
}

function closeHouseholdInviteModal() {
    document.getElementById('householdInviteModal')?.classList.add('hidden');
}

async function handleLogout() {
    try {
        const { error } = await authClient.auth.signOut();
        if (error) {
            console.error("Supabase logout failed:", error);
            alert("Logout failed: " + error.message);
            return;
        }
        localStorage.removeItem(pendingInviteKey);
        window.location.assign('login.html');
    } catch (error) {
        console.error("Unexpected error during logout:", error);
        alert("Logout failed. See the browser console for details.");
    }
}

window.HomeStockAuth = { acceptHouseholdInvite };

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeAuthPage, { once: true });
} else {
    initializeAuthPage();
}

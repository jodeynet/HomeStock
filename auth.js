const authClient = window.supabaseClient;
const pendingInviteKey = window.HOMESTOCK_PENDING_HOUSEHOLD_INVITE_KEY;

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

async function handleLogin() {
    const email = document.getElementById('authEmail').value.trim();
    const password = document.getElementById('authPassword').value;
    const inviteCode = document.getElementById('householdInviteCode')?.value.trim();
    if (!email || !password) {
        setAuthStatus("Enter your email and password.", true);
        return;
    }

    try {
        const { error } = await authClient.auth.signInWithPassword({ email, password });
        if (error) {
            console.error("Supabase login failed:", error);
            setAuthStatus(error.message, true);
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
    const email = document.getElementById('authEmail').value.trim();
    const password = document.getElementById('authPassword').value;
    const passwordConfirm = document.getElementById('authPasswordConfirm').value;
    const inviteCode = document.getElementById('householdInviteCode').value.trim();
    if (!email || !password || !inviteCode) {
        setAuthStatus("Enter your email, password, and household invite code.", true);
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
        localStorage.setItem(pendingInviteKey, inviteCode);
        const confirmationUrl = new URL('signup.html', window.location.href);
        confirmationUrl.searchParams.set('invite', inviteCode);
        const { data, error } = await authClient.auth.signUp({
            email,
            password,
            options: {
                emailRedirectTo: confirmationUrl.href
            }
        });
        if (error) {
            console.error("Supabase sign-up failed:", error);
            localStorage.removeItem(pendingInviteKey);
            setAuthStatus(error.message, true);
            return;
        }

        if (data.session) {
            if (await acceptHouseholdInvite(inviteCode)) {
                window.location.assign('index.html');
            } else {
                document.getElementById('authForm')?.classList.add('hidden');
                setButtonVisible('joinHouseholdButton', true);
            }
            return;
        }

        setAuthStatus("Account created. Confirm your email, then log in here to finish joining the household.");
    } catch (error) {
        console.error("Unexpected error during sign-up:", error);
        setAuthStatus("Sign-up failed. Please try again.", true);
    }
}

function getPasswordRequirements(password) {
    const normalizedPassword = password.replace(/[^a-z0-9]/gi, '').toLowerCase();
    const commonPasswords = new Set([
        'password', 'password1', 'password123', 'passw0rd', 'qwerty', 'qwerty123',
        '123456', '1234567', '12345678', '123456789', '111111', '000000',
        'letmein', 'welcome', 'welcome1', 'admin', 'admin123', 'iloveyou',
        'monkey', 'dragon', 'sunshine', 'princess', 'football', 'baseball',
        'trustno1', 'changeme', 'abc123', 'login'
    ]);
    const commonPrefixes = [
        'password', 'passw0rd', 'qwerty', 'letmein', 'welcome', 'admin',
        'iloveyou', 'monkey', 'dragon', 'sunshine', 'princess', 'football',
        'baseball', 'trustno1', 'changeme'
    ];
    const isCommon = commonPasswords.has(normalizedPassword)
        || commonPrefixes.some(prefix => normalizedPassword.startsWith(prefix)
            && /^\d{1,4}$/.test(normalizedPassword.slice(prefix.length)));

    return {
        length: password.length >= 7,
        uppercase: /[A-Z]/.test(password),
        lowercase: /[a-z]/.test(password),
        special: /[^A-Za-z0-9]/.test(password),
        common: !isCommon,
        predictable: !hasPredictablePasswordPattern(normalizedPassword)
    };
}

function hasPredictablePasswordPattern(password) {
    if (/(.)\1{3,}/.test(password)) return true;

    let sequentialLength = 1;
    for (let index = 1; index < password.length; index += 1) {
        const difference = password.charCodeAt(index) - password.charCodeAt(index - 1);
        if (Math.abs(difference) === 1) {
            sequentialLength = difference === password.charCodeAt(index - 1) - password.charCodeAt(index - 2)
                ? sequentialLength + 1
                : 2;
            if (sequentialLength >= 4) return true;
        } else {
            sequentialLength = 1;
        }
    }

    const keyboardRows = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
    return keyboardRows.some(row => {
        const reversedRow = [...row].reverse().join('');
        return [row, reversedRow].some(sequence => {
            for (let index = 0; index <= sequence.length - 4; index += 1) {
                if (password.includes(sequence.slice(index, index + 4))) return true;
            }
            return false;
        });
    });
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

async function joinHouseholdWithCode() {
    const inviteCode = document.getElementById('householdInviteCode').value.trim();
    if (!inviteCode) {
        setAuthStatus("Enter a household invite code first.", true);
        return;
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
        if (await acceptHouseholdInvite(inviteCode)) window.location.assign('index.html');
    } catch (error) {
        console.error("Unexpected error while joining a household:", error);
        setAuthStatus("Could not join the household. Please try again.", true);
    }
}

async function initializeAuthPage() {
    const page = document.body.dataset.authPage;
    if (!page) return;

    if (page === 'signup') {
        document.getElementById('authPassword')?.addEventListener('input', updateSignupPasswordFeedback);
        document.getElementById('authPasswordConfirm')?.addEventListener('input', updateSignupPasswordFeedback);
        updateSignupPasswordFeedback();
    }

    const params = new URLSearchParams(window.location.search);
    const inviteCode = params.get('invite') || localStorage.getItem(pendingInviteKey) || '';
    const inviteField = document.getElementById('householdInviteCode');
    if (inviteField) inviteField.value = inviteCode;
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

    const form = document.getElementById('authForm');
    if (form) form.classList.add('hidden');
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
    try {
        await navigator.clipboard.writeText(inviteUrl.href);
        alert("Invite link copied! Send it to someone you'd like to welcome into your household.");
    } catch (error) {
        console.error("Clipboard copy failed:", error);
        window.prompt("Share this invite link with someone you'd like to welcome into your household:", inviteUrl.href);
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

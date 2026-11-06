const recoveryAuth = window.supabaseClient.auth;
let passwordRecoverySession = null;

function setResetPasswordStatus(message, isError = false) {
    const status = document.getElementById('resetPasswordStatus');
    status.textContent = message;
    status.classList.toggle('text-red-300', isError);
    status.classList.toggle('text-emerald-300', !isError);
}

function showPasswordResetForm(session) {
    if (!session?.user) return;
    passwordRecoverySession = session;
    document.getElementById('resetPasswordForm').classList.remove('hidden');
    setResetPasswordStatus('Your reset link is valid. Enter your new password below.');
    document.getElementById('resetNewPassword').focus();
    window.history.replaceState(null, document.title, window.location.pathname);
}

recoveryAuth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') showPasswordResetForm(session);
});

async function initializePasswordReset() {
    const { data, error } = await recoveryAuth.getSession();
    if (error) {
        console.error('Could not validate the password reset link:', error);
        setResetPasswordStatus('We could not verify this reset link. Request a new one and try again.', true);
        return;
    }

    if (window.HOMESTOCK_PASSWORD_RECOVERY_LINK && data.session) {
        showPasswordResetForm(data.session);
        return;
    }

    window.HOMESTOCK_PASSWORD_RECOVERY_LINK = false;
    setResetPasswordStatus('This password reset link is invalid or has expired. Request a new link from the log-in page.', true);
}

async function submitPasswordReset() {
    const passwordInput = document.getElementById('resetNewPassword');
    const confirmInput = document.getElementById('resetConfirmPassword');
    const submitButton = document.getElementById('resetPasswordSubmit');
    const password = passwordInput.value;

    if (!passwordRecoverySession) {
        setResetPasswordStatus('Your reset session has expired. Request a new link and try again.', true);
        return;
    }
    if (!arePasswordRequirementsMet(password)) {
        setResetPasswordStatus('Your password must meet all the listed requirements.', true);
        passwordInput.focus();
        return;
    }
    if (password !== confirmInput.value) {
        setResetPasswordStatus("Your passwords don't match. Please check both fields.", true);
        confirmInput.focus();
        return;
    }

    submitButton.disabled = true;
    submitButton.textContent = 'Updating…';
    try {
        const { error } = await recoveryAuth.updateUser({ password });
        if (error) {
            console.error('Password reset update failed:', error);
            setResetPasswordStatus(`Could not update your password: ${error.message}`, true);
            return;
        }

        passwordRecoverySession = null;
        document.getElementById('resetPasswordForm').classList.add('hidden');
        document.getElementById('resetPasswordLoginLink').textContent = 'Continue to HomeStock';
        setResetPasswordStatus('Your password has been updated. You can now log in with your new password.');
    } catch (error) {
        console.error('Unexpected error while updating the password:', error);
        setResetPasswordStatus('Could not update your password. Please try again.', true);
    } finally {
        submitButton.disabled = false;
        submitButton.textContent = 'Update password';
    }
}

initializePasswordReset();

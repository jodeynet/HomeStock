const passwordResetClient = window.supabaseClient.auth;

function setForgotPasswordStatus(message, isError = false) {
    const status = document.getElementById('forgotPasswordStatus');
    status.textContent = message;
    status.classList.toggle('text-red-300', isError);
    status.classList.toggle('text-emerald-300', !isError);
    status.classList.remove('hidden');
}

async function sendPasswordResetEmail() {
    const emailInput = document.getElementById('recoveryEmail');
    const button = document.getElementById('sendResetLinkButton');
    const email = emailInput.value.trim();

    if (!emailInput.checkValidity()) {
        emailInput.reportValidity();
        return;
    }

    button.disabled = true;
    button.textContent = 'Sending…';
    try {
        const redirectTo = new URL('reset-password.html', window.location.href).href;
        const { error } = await passwordResetClient.resetPasswordForEmail(email, { redirectTo });
        if (error) {
            console.error('Password reset request failed:', error);
            setForgotPasswordStatus(`We couldn’t send the reset email. ${error.message}`, true);
            return;
        }

        setForgotPasswordStatus('If an account exists for that email, a reset link is on its way. Check your inbox and spam folder.');
        button.textContent = 'Resend reset link';
    } catch (error) {
        console.error('Unexpected error while requesting a password reset:', error);
        setForgotPasswordStatus('We couldn’t send the reset email. Please try again.', true);
    } finally {
        button.disabled = false;
        if (button.textContent === 'Sending…') button.textContent = 'Send reset link';
    }
}

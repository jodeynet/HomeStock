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
        const redirectUrl = new URL('reset-password.html', window.location.href);
        redirectUrl.searchParams.set('type', 'recovery');
        localStorage.setItem('homestock_password_recovery_pending', 'true');
        const redirectTo = redirectUrl.href;
        const { error } = await passwordResetClient.resetPasswordForEmail(email, { redirectTo });
        if (error) {
            localStorage.removeItem('homestock_password_recovery_pending');
            console.error('Password reset request failed:', error);
            if (error.status === 500) {
                setForgotPasswordStatus(
                    'Supabase could not send the recovery email. Check Auth logs in your Supabase dashboard. If you use the default SMTP service, it only sends to members of your Supabase organization and is limited to 2 emails per hour; configure custom SMTP for other recipients.',
                    true
                );
            } else if (error.status === 429) {
                setForgotPasswordStatus('Too many reset requests were made. Please wait before requesting another email.', true);
            } else {
                setForgotPasswordStatus(`We couldn’t send the reset email. ${error.message}`, true);
            }
            return;
        }

        setForgotPasswordStatus('If an account exists for that email, a reset link is on its way. Check your inbox and spam folder.');
        button.textContent = 'Resend reset link';
    } catch (error) {
        localStorage.removeItem('homestock_password_recovery_pending');
        console.error('Unexpected error while requesting a password reset:', error);
        setForgotPasswordStatus('We couldn’t send the reset email. Please try again.', true);
    } finally {
        button.disabled = false;
        if (button.textContent === 'Sending…') button.textContent = 'Send reset link';
    }
}

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

function arePasswordRequirementsMet(password) {
    return Object.values(getPasswordRequirements(password)).every(Boolean);
}

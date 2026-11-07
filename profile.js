const profileClient = window.supabaseClient;

let profileUser = null;
let profileHouseholdId = null;
let profileRole = null;

function setProfileStatus(message, isError = false) {
    const status = document.getElementById('profileStatus');
    status.textContent = message;
    status.classList.toggle('hidden', !message);
    status.classList.toggle('border-red-400/30', isError);
    status.classList.toggle('bg-red-950/40', isError);
    status.classList.toggle('text-red-200', isError);
    status.classList.toggle('border-emerald-400/30', !isError);
    status.classList.toggle('bg-emerald-950/30', !isError);
    status.classList.toggle('text-emerald-200', !isError);
}

function setHouseholdOwnerControls(isOwner) {
    const nameInput = document.getElementById('householdName');
    const saveButton = document.getElementById('saveHouseholdNameButton');
    nameInput.disabled = !isOwner;
    saveButton.disabled = !isOwner;
    if (!isOwner) {
        document.getElementById('householdNameHelp').textContent = 'Only the household owner can change this name.';
    }
}

function renderHouseholdMembers(members) {
    const list = document.getElementById('memberList');
    list.replaceChildren();
    document.getElementById('memberCount').textContent = `${members.length} ${members.length === 1 ? 'member' : 'members'}`;

    for (const member of members) {
        const row = document.createElement('div');
        row.className = 'flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between';

        const identity = document.createElement('div');
        identity.className = 'flex min-w-0 items-center gap-3';
        const avatar = document.createElement('span');
        avatar.className = 'flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-800 text-slate-300';
        const avatarIcon = document.createElement('i');
        avatarIcon.className = 'ph ph-user text-lg';
        avatar.append(avatarIcon);

        const details = document.createElement('div');
        details.className = 'min-w-0';
        const name = document.createElement('p');
        name.className = 'truncate text-sm font-semibold text-white';
        name.textContent = member.display_name || member.email || 'Household member';
        const email = document.createElement('p');
        email.className = 'truncate text-xs text-slate-400';
        email.textContent = member.email || '';
        details.append(name, email);
        identity.append(avatar, details);

        const controls = document.createElement('div');
        controls.className = 'flex items-center gap-3 pl-[52px] sm:pl-0';
        const role = document.createElement('span');
        role.className = member.role === 'owner'
            ? 'rounded-full border border-amber-400/20 bg-amber-400/10 px-2.5 py-1 text-xs font-semibold capitalize text-amber-200'
            : 'rounded-full border border-slate-600/50 bg-slate-800/70 px-2.5 py-1 text-xs font-semibold capitalize text-slate-300';
        role.textContent = member.role;
        controls.append(role);

        if (profileRole === 'owner' && member.role !== 'owner' && member.user_id !== profileUser.id) {
            const removeButton = document.createElement('button');
            removeButton.type = 'button';
            removeButton.className = 'rounded-lg px-2.5 py-1.5 text-xs font-semibold text-red-300 transition hover:bg-red-950/60 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-50';
            removeButton.textContent = 'Remove';
            removeButton.setAttribute('aria-label', `Remove ${member.display_name || member.email} from household`);
            removeButton.addEventListener('click', () => removeHouseholdMember(member, removeButton));
            controls.append(removeButton);
        }

        row.append(identity, controls);
        list.append(row);
    }
}

async function loadProfilePage() {
    try {
        const { data: userData, error: userError } = await profileClient.auth.getUser();
        if (userError) throw userError;
        if (!userData.user) {
            window.location.replace('login.html');
            return;
        }
        profileUser = userData.user;

        const metadata = profileUser.user_metadata || {};
        const fallbackName = metadata.full_name || metadata.name || '';
        const firstName = metadata.first_name || fallbackName.split(/\s+/)[0] || '';
        const lastName = metadata.last_name
            || (fallbackName.includes(' ') ? fallbackName.substring(fallbackName.indexOf(' ') + 1) : '');
        document.getElementById('profileFirstName').value = firstName;
        document.getElementById('profileLastName').value = lastName;
        document.getElementById('profileName').textContent = [firstName, lastName].filter(Boolean).join(' ')
            || profileUser.email
            || 'HomeStock user';
        document.getElementById('profileEmail').textContent = profileUser.email || 'Not available';
        document.getElementById('profileCreatedAt').textContent = profileUser.created_at
            ? new Date(profileUser.created_at).toLocaleDateString()
            : 'Not available';

        const { data: membership, error: membershipError } = await profileClient
            .from('household_members')
            .select('household_id, role')
            .eq('user_id', profileUser.id)
            .maybeSingle();
        if (membershipError) throw membershipError;
        if (!membership?.household_id) {
            window.location.replace('login.html?join=1');
            return;
        }
        profileHouseholdId = membership.household_id;
        profileRole = membership.role === 'owner' ? 'owner' : 'member';
        document.getElementById('profileRole').textContent = profileRole;
        setHouseholdOwnerControls(profileRole === 'owner');

        const { data: household, error: householdError } = await profileClient
            .from('households')
            .select('name')
            .eq('id', profileHouseholdId)
            .maybeSingle();
        if (householdError) throw householdError;
        if (!household) throw new Error('Your household could not be found.');
        document.getElementById('householdName').value = household.name || '';
        document.getElementById('householdNameHelp').textContent = profileRole === 'owner'
            ? 'This name is shown to everyone in your household.'
            : 'Only the household owner can change this name.';

        try {
            await loadHouseholdMembers();
        } catch (error) {
            document.getElementById('memberCount').textContent = 'Members unavailable';
            setProfileStatus(error.message, true);
        }
    } catch (error) {
        console.error('Failed to load profile and household details:', error);
        setProfileStatus(`Couldn't load your profile: ${error.message || 'Please try again.'}`, true);
    }
}

async function loadHouseholdMembers() {
    const { data, error } = await profileClient.rpc('get_household_members_for_current_user');
    if (error) {
        console.error('Failed to load household members:', error);
        throw new Error(`Couldn't load household members: ${error.message}`);
    }
    renderHouseholdMembers(data || []);
}

function showProfileNameEditor() {
    document.getElementById('profileNameDisplay').classList.add('hidden');
    document.getElementById('profileNameForm').classList.remove('hidden');
    document.getElementById('profileFirstName').focus();
}

function cancelProfileNameEdit() {
    const metadata = profileUser?.user_metadata || {};
    const fallbackName = metadata.full_name || metadata.name || '';
    document.getElementById('profileFirstName').value = metadata.first_name || fallbackName.split(/\s+/)[0] || '';
    document.getElementById('profileLastName').value = metadata.last_name
        || (fallbackName.includes(' ') ? fallbackName.substring(fallbackName.indexOf(' ') + 1) : '');
    document.getElementById('profileNameForm').classList.add('hidden');
    document.getElementById('profileNameDisplay').classList.remove('hidden');
}

async function saveProfileName() {
    const firstNameInput = document.getElementById('profileFirstName');
    const lastNameInput = document.getElementById('profileLastName');
    const firstName = firstNameInput.value.trim();
    const lastName = lastNameInput.value.trim();
    if (!firstName || !lastName || firstName.length > 80 || lastName.length > 80) {
        setProfileStatus('Enter a first and last name, each no longer than 80 characters.', true);
        return;
    }

    const button = document.getElementById('saveProfileNameButton');
    button.disabled = true;
    try {
        const fullName = `${firstName} ${lastName}`;
        const { data, error } = await profileClient.auth.updateUser({
            data: {
                first_name: firstName,
                last_name: lastName,
                full_name: fullName
            }
        });
        if (error) throw error;
        profileUser = data.user;
        document.getElementById('profileName').textContent = fullName;
        document.getElementById('profileNameForm').classList.add('hidden');
        document.getElementById('profileNameDisplay').classList.remove('hidden');
        setProfileStatus('Your profile name was updated.');
        try {
            await loadHouseholdMembers();
        } catch (error) {
            console.error('Profile name was updated, but the household member list could not be refreshed:', error);
            setProfileStatus('Your profile name was updated, but the household member list could not be refreshed.', true);
        }
    } catch (error) {
        console.error('Failed to update profile name:', error);
        setProfileStatus(`Couldn't update your name: ${error.message || 'Please try again.'}`, true);
    } finally {
        button.disabled = false;
    }
}

async function saveHouseholdName() {
    if (profileRole !== 'owner') return;
    const input = document.getElementById('householdName');
    const name = input.value.trim();
    if (!name || name.length > 60) {
        setProfileStatus('Enter a household name between 1 and 60 characters.', true);
        input.focus();
        return;
    }

    const button = document.getElementById('saveHouseholdNameButton');
    button.disabled = true;
    try {
        const { error } = await profileClient.rpc('update_current_household_name', {
            p_household_name: name
        });
        if (error) throw error;
        input.value = name;
        setProfileStatus('Household name updated.');
    } catch (error) {
        console.error('Failed to update household name:', error);
        setProfileStatus(`Couldn't update the household name: ${error.message || 'Please try again.'}`, true);
    } finally {
        button.disabled = false;
    }
}

async function removeHouseholdMember(member, button) {
    const label = member.display_name || member.email || 'this member';
    if (!window.confirm(`Remove ${label} from your household? They will lose access to shared household information.`)) return;

    button.disabled = true;
    try {
        const { error } = await profileClient.rpc('remove_household_member', {
            p_member_user_id: member.user_id
        });
        if (error) throw error;
    } catch (error) {
        console.error('Failed to remove household member:', error);
        setProfileStatus(`Couldn't remove ${label}: ${error.message || 'Please try again.'}`, true);
        button.disabled = false;
        return;
    }

    setProfileStatus(`${label} was removed from the household.`);
    try {
        await loadHouseholdMembers();
    } catch (error) {
        document.getElementById('memberCount').textContent = 'Members unavailable';
        setProfileStatus(`${label} was removed, but the member list couldn't refresh: ${error.message}`, true);
    }
}

document.addEventListener('DOMContentLoaded', loadProfilePage, { once: true });

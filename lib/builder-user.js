// lib/builder-user.js
// Server-only helpers for keeping the ProLine Builder customer row in Supabase
// synchronized with the authenticated Clerk account.
import { currentUser } from '@clerk/nextjs/server';

function getClerkIdentity(user) {
  if (!user) return { name: null, email: null };

  const email =
    user.primaryEmailAddress?.emailAddress ||
    user.emailAddresses?.find(address => address.id === user.primaryEmailAddressId)?.emailAddress ||
    user.emailAddresses?.[0]?.emailAddress ||
    null;

  const fullName = [user.firstName, user.lastName]
    .filter(Boolean)
    .join(' ')
    .trim();

  const name = fullName || user.username || null;

  return { name, email };
}

export async function syncBuilderUserIdentity(supabaseAdmin, userId) {
  const clerkUser = await currentUser();

  // currentUser() should represent the same authenticated account, but keep the
  // check explicit so this helper can never write one user's identity to another row.
  if (!clerkUser || clerkUser.id !== userId) {
    return { name: null, email: null, synced: false };
  }

  const identity = getClerkIdentity(clerkUser);
  const update = {};

  if (identity.name) update.name = identity.name;
  if (identity.email) update.email = identity.email;

  if (Object.keys(update).length === 0) {
    return { ...identity, synced: false };
  }

  const { error } = await supabaseAdmin
    .from('users')
    .update(update)
    .eq('id', userId);

  if (error) {
    throw error;
  }

  return { ...identity, synced: true };
}

export async function ensureBuilderUser(supabaseAdmin, userId) {
  const { data, error } = await supabaseAdmin.rpc('get_or_create_builder_user', {
    p_user_id: userId,
  });

  if (error) throw error;

  const identity = await syncBuilderUserIdentity(supabaseAdmin, userId);

  return {
    data,
    identity,
    user: Array.isArray(data) ? data[0] : data,
  };
}

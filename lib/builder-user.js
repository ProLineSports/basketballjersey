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

  // Read the actual row after initialization so account-wide entitlements added
  // after the original RPC (such as Lifetime All-Access) are always available to
  // every Builder without changing the RPC's established return signature.
  const { data: user, error: userError } = await supabaseAdmin
    .from('users')
    .select(
      'id, name, email, free_credits, paid_credits, is_unlimited, lifetime_all_access, stripe_customer_id, stripe_subscription_id, stripe_subscription_status'
    )
    .eq('id', userId)
    .single();

  if (userError) throw userError;

  return {
    data,
    identity,
    user,
  };
}

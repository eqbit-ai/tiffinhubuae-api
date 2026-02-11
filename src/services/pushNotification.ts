/**
 * Push Notification Service using Expo Push API
 * Sends push notifications to mobile devices via Expo's notification infrastructure.
 * No Firebase SDK needed — Expo handles FCM/APNs routing.
 */

import { prisma } from '../lib/prisma';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

interface PushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, any>;
  sound?: 'default' | null;
  badge?: number;
  channelId?: string;
}

interface PushTicket {
  id?: string;
  status: 'ok' | 'error';
  message?: string;
  details?: { error?: string };
}

/**
 * Send push notifications to one or more Expo push tokens
 */
async function sendExpoPush(messages: PushMessage[]): Promise<PushTicket[]> {
  if (messages.length === 0) return [];

  try {
    const response = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messages),
    });

    const result: any = await response.json();
    return result.data || [];
  } catch (error) {
    console.error('[Push] Failed to send via Expo Push API:', error);
    return [];
  }
}

/**
 * Send push notification to a specific user (merchant) by user ID
 */
export async function sendPushToUser(
  userId: string,
  title: string,
  body: string,
  data?: Record<string, any>
): Promise<void> {
  const tokens = await prisma.deviceToken.findMany({
    where: { user_id: userId, is_active: true },
  });

  if (tokens.length === 0) return;

  const messages: PushMessage[] = tokens.map((t) => ({
    to: t.expo_push_token,
    title,
    body,
    data: { ...data, type: data?.type || 'general' },
    sound: 'default',
    channelId: 'default',
  }));

  const tickets = await sendExpoPush(messages);

  // Deactivate tokens that returned errors (device unregistered, etc.)
  for (let i = 0; i < tickets.length; i++) {
    const ticket = tickets[i];
    if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
      await prisma.deviceToken.update({
        where: { id: tokens[i].id },
        data: { is_active: false },
      }).catch(() => {});
    }
  }
}

/**
 * Send push notification to a user by email
 */
export async function sendPushToUserByEmail(
  userEmail: string,
  title: string,
  body: string,
  data?: Record<string, any>
): Promise<void> {
  const tokens = await prisma.deviceToken.findMany({
    where: { user_email: userEmail, is_active: true },
  });

  if (tokens.length === 0) return;

  const messages: PushMessage[] = tokens.map((t) => ({
    to: t.expo_push_token,
    title,
    body,
    data: { ...data, type: data?.type || 'general' },
    sound: 'default',
    channelId: 'default',
  }));

  const tickets = await sendExpoPush(messages);

  for (let i = 0; i < tickets.length; i++) {
    const ticket = tickets[i];
    if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
      await prisma.deviceToken.update({
        where: { id: tokens[i].id },
        data: { is_active: false },
      }).catch(() => {});
    }
  }
}

/**
 * Send push notification to a customer by customer ID
 */
export async function sendPushToCustomer(
  customerId: string,
  title: string,
  body: string,
  data?: Record<string, any>
): Promise<void> {
  const tokens = await prisma.deviceToken.findMany({
    where: { customer_id: customerId, is_active: true },
  });

  if (tokens.length === 0) return;

  const messages: PushMessage[] = tokens.map((t) => ({
    to: t.expo_push_token,
    title,
    body,
    data: { ...data, type: data?.type || 'general' },
    sound: 'default',
    channelId: 'default',
  }));

  await sendExpoPush(messages);
}

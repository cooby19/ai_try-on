import "server-only";

import { validateSavedAddressInput, type SavedAddressInput } from "./checkout-validation";
import { AppError } from "./http";
import { getSupabaseAdmin } from "./supabase";
import type { AddressBookEntry } from "./types";

interface AddressRow {
  id: string;
  label: string;
  recipient_name: string;
  recipient_phone: string;
  recipient_address: string;
  updated_at: string;
}

function toAddressView(row: AddressRow): AddressBookEntry {
  return {
    id: row.id,
    label: row.label,
    recipientName: row.recipient_name,
    recipientPhone: row.recipient_phone,
    recipientAddress: row.recipient_address,
    updatedAt: row.updated_at,
  };
}

function validatedAddress(input: unknown): SavedAddressInput {
  const result = validateSavedAddressInput(input);
  if (!result.ok) throw new AppError(400, result.message);
  return result.value;
}

export async function getAddressesForUser(userId: string): Promise<AddressBookEntry[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("addresses")
    .select("id, label, recipient_name, recipient_phone, recipient_address, updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .returns<AddressRow[]>();
  if (error) throw new AppError(500, `地址簿讀取失敗：${error.message}`);
  return (data ?? []).map(toAddressView);
}

export async function createAddressForUser(userId: string, input: unknown): Promise<AddressBookEntry> {
  const address = validatedAddress(input);
  const { data, error } = await getSupabaseAdmin()
    .from("addresses")
    .insert({
      user_id: userId,
      label: address.label,
      recipient_name: address.recipientName,
      recipient_phone: address.recipientPhone,
      recipient_address: address.recipientAddress,
    })
    .select("id, label, recipient_name, recipient_phone, recipient_address, updated_at")
    .single<AddressRow>();
  if (error) throw new AppError(500, `地址新增失敗：${error.message}`);
  return toAddressView(data);
}

export async function updateAddressForUser(
  userId: string,
  addressId: string,
  input: unknown
): Promise<AddressBookEntry> {
  const address = validatedAddress(input);
  const { data, error } = await getSupabaseAdmin()
    .from("addresses")
    .update({
      label: address.label,
      recipient_name: address.recipientName,
      recipient_phone: address.recipientPhone,
      recipient_address: address.recipientAddress,
      updated_at: new Date().toISOString(),
    })
    .eq("id", addressId)
    .eq("user_id", userId)
    .select("id, label, recipient_name, recipient_phone, recipient_address, updated_at")
    .maybeSingle<AddressRow>();
  if (error) throw new AppError(500, `地址更新失敗：${error.message}`);
  if (!data) throw new AppError(404, "找不到這筆地址。" );
  return toAddressView(data);
}

export async function deleteAddressForUser(userId: string, addressId: string): Promise<void> {
  const { data, error } = await getSupabaseAdmin()
    .from("addresses")
    .delete()
    .eq("id", addressId)
    .eq("user_id", userId)
    .select("id")
    .returns<{ id: string }[]>();
  if (error) throw new AppError(500, `地址刪除失敗：${error.message}`);
  if (!data?.length) throw new AppError(404, "找不到這筆地址。" );
}

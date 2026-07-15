import { NextResponse } from "next/server";
import { deleteAddressForUser, updateAddressForUser } from "@/lib/addresses";
import { isUuid } from "@/lib/cart-storage";
import { errorMessage, errorStatus } from "@/lib/http";
import { requireUser } from "@/lib/user";

type Context = { params: Promise<{ addressId: string }> };

export async function PATCH(request: Request, { params }: Context) {
  try {
    const { addressId } = await params;
    if (!isUuid(addressId)) return NextResponse.json({ status: "failed", message: "地址識別碼格式不正確。" }, { status: 400 });
    const userId = (await requireUser()).id;
    const body = await request.json().catch(() => null);
    return NextResponse.json(await updateAddressForUser(userId, addressId, body));
  } catch (error) {
    return NextResponse.json({ status: "failed", message: errorMessage(error) }, { status: errorStatus(error) });
  }
}

export async function DELETE(_request: Request, { params }: Context) {
  try {
    const { addressId } = await params;
    if (!isUuid(addressId)) return NextResponse.json({ status: "failed", message: "地址識別碼格式不正確。" }, { status: 400 });
    const userId = (await requireUser()).id;
    await deleteAddressForUser(userId, addressId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return NextResponse.json({ status: "failed", message: errorMessage(error) }, { status: errorStatus(error) });
  }
}

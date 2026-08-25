import { NextResponse } from "next/server";
import { errorResponse, parseBuilderType, requireProLineUser } from "@/lib/saved-designs";

export const runtime = "nodejs";

export async function GET(request) {
  try {
    const { userId, saveLimit, plan, supabase } = await requireProLineUser();
    const builderType = parseBuilderType(request.nextUrl.searchParams.get("builder"));
    const { data, error, count } = await supabase
      .from("saved_designs")
      .select("id,name,builder_type,thumbnail_path,created_at,updated_at", { count: "exact" })
      .eq("user_id", userId)
      .eq("builder_type", builderType)
      .order("updated_at", { ascending: false });
    if (error) throw error;
    return NextResponse.json({ designs: data || [], count: count || 0, limit: saveLimit, plan });
  } catch (error) {
    return errorResponse(error);
  }
}

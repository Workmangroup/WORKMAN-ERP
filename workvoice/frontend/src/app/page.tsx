"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { ROLE_HOME } from "@/lib/constants";
import { FullPageLoader } from "@/components/common/states";

export default function Home() {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading) router.replace(user ? ROLE_HOME[user.role] : "/login/");
  }, [user, loading, router]);

  return <FullPageLoader />;
}

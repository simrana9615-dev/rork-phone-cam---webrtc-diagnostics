import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { Home, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";

const NotFound = () => {
  const location = useLocation();

  useEffect(() => {
    console.error("404 Error: User attempted to access non-existent route:", location.pathname);
  }, [location.pathname]);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4">
      <div className="animate-rise w-full max-w-sm rounded-2xl border border-border/70 bg-card p-6 text-center">
        <ShieldAlert className="mx-auto h-10 w-10 text-amber-400" />
        <h1 className="mt-3 text-3xl font-bold tracking-tight">404</h1>
        <p className="mt-1 text-sm text-muted-foreground">This page doesn't exist.</p>
        <p className="mono mt-1 truncate text-[10px] text-muted-foreground/70">{location.pathname}</p>
        <Button asChild className="mt-4 h-11 w-full">
          <Link to="/">
            <Home className="mr-2 h-4 w-4" />
            Back to the Dashboard
          </Link>
        </Button>
      </div>
    </div>
  );
};

export default NotFound;

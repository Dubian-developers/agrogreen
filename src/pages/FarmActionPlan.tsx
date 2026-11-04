import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertTriangle, ArrowUpRight, Bug, Check, ClipboardCheck, CloudSun, Droplets, LoaderCircle, Sprout } from "lucide-react";
import { toast } from "sonner";
import { PageShell } from "@/components/PageShell";

type TaskKind = "climate" | "pest" | "irrigation";
type ActionTask = {
  id: string;
  kind: TaskKind;
  farmName: string;
  title: string;
  description: string;
  severity: string;
  dueDate: string;
  href: string;
  schedule?: { frequency: string; nextDate: string };
};

type Farm = { id: string; name: string };

const severityRank: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
const taskIcons = { climate: CloudSun, pest: Bug, irrigation: Droplets };
const severityVariants: Record<string, "destructive" | "secondary" | "outline"> = {
  critical: "destructive",
  high: "destructive",
  medium: "secondary",
  low: "outline",
};

const FarmActionPlan = () => {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<ActionTask[]>([]);
  const [farms, setFarms] = useState<Farm[]>([]);
  const [loading, setLoading] = useState(true);
  const [updatingTaskId, setUpdatingTaskId] = useState<string | null>(null);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user) {
        navigate("/auth");
        return;
      }

      const { data: farmData, error: farmError } = await supabase
        .from("farms")
        .select("id, name")
        .eq("user_id", session.user.id);
      if (farmError) throw farmError;

      const farmList = farmData || [];
      setFarms(farmList);
      const farmIds = farmList.map((farm) => farm.id);
      if (farmIds.length === 0) {
        setTasks([]);
        return;
      }

      const todayEnd = new Date();
      todayEnd.setHours(23, 59, 59, 999);
      const [climateResult, pestResult, irrigationResult] = await Promise.all([
        supabase
          .from("climate_alerts")
          .select("id, farm_id, alert_type, severity, description, forecast_date")
          .in("farm_id", farmIds)
          .eq("is_read", false)
          .order("forecast_date", { ascending: true }),
        supabase
          .from("pest_disease_alerts")
          .select("id, farm_id, severity, pest_disease_name, treatment_recommendations, detected_date")
          .in("farm_id", farmIds)
          .eq("is_resolved", false)
          .order("detected_date", { ascending: true }),
        supabase
          .from("irrigation_schedules")
          .select("id, farm_id, schedule_name, frequency, next_irrigation_date")
          .in("farm_id", farmIds)
          .eq("status", "active")
          .lte("next_irrigation_date", todayEnd.toISOString())
          .order("next_irrigation_date", { ascending: true }),
      ]);

      if (climateResult.error) throw climateResult.error;
      if (pestResult.error) throw pestResult.error;
      if (irrigationResult.error) throw irrigationResult.error;

      const farmNames = new Map(farmList.map((farm) => [farm.id, farm.name]));
      const climateTasks: ActionTask[] = (climateResult.data || []).map((alert) => ({
        id: alert.id,
        kind: "climate",
        farmName: farmNames.get(alert.farm_id) || "Farm",
        title: `${alert.alert_type} alert`,
        description: alert.description,
        severity: alert.severity.toLowerCase(),
        dueDate: alert.forecast_date,
        href: "/climate-alerts",
      }));
      const pestTasks: ActionTask[] = (pestResult.data || []).map((alert) => ({
        id: alert.id,
        kind: "pest",
        farmName: farmNames.get(alert.farm_id) || "Farm",
        title: `${alert.pest_disease_name} detected`,
        description: alert.treatment_recommendations || "Review the alert and inspect the affected area.",
        severity: String(alert.severity || "medium").toLowerCase(),
        dueDate: alert.detected_date,
        href: "/pest-disease",
      }));
      const irrigationTasks: ActionTask[] = (irrigationResult.data || []).map((schedule) => ({
        id: schedule.id,
        kind: "irrigation",
        farmName: farmNames.get(schedule.farm_id) || "Farm",
        title: `${schedule.schedule_name} is due`,
        description: "Complete this irrigation and the next date will be scheduled automatically.",
        severity: "medium",
        dueDate: schedule.next_irrigation_date,
        href: "/irrigation",
        schedule: { frequency: schedule.frequency, nextDate: schedule.next_irrigation_date },
      }));

      setTasks([...climateTasks, ...pestTasks, ...irrigationTasks]);
    } catch (error) {
      console.error("Failed to load farm action plan:", error);
      toast.error("Could not load your farm action plan");
    } finally {
      setLoading(false);
    }
  }, [navigate]);

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  const sortedTasks = useMemo(() => [...tasks].sort((a, b) => {
    const priority = (severityRank[b.severity] || 2) - (severityRank[a.severity] || 2);
    return priority || new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
  }), [tasks]);

  const completeTask = async (task: ActionTask) => {
    setUpdatingTaskId(task.id);
    try {
      if (task.kind === "climate") {
        const { error } = await supabase.from("climate_alerts").update({ is_read: true }).eq("id", task.id);
        if (error) throw error;
      } else if (task.kind === "pest") {
        const { error } = await supabase.from("pest_disease_alerts").update({ is_resolved: true }).eq("id", task.id);
        if (error) throw error;
      } else {
        const intervalDays = task.schedule?.frequency === "daily" ? 1 : task.schedule?.frequency === "bi-weekly" ? 14 : 7;
        const nextDate = new Date();
        nextDate.setDate(nextDate.getDate() + intervalDays);
        const { error } = await supabase
          .from("irrigation_schedules")
          .update({ next_irrigation_date: nextDate.toISOString() })
          .eq("id", task.id);
        if (error) throw error;
      }

      toast.success(task.kind === "irrigation" ? "Irrigation completed and rescheduled" : "Farm action completed");
      await loadTasks();
    } catch (error) {
      console.error("Failed to complete farm action:", error);
      toast.error("Could not update this action");
    } finally {
      setUpdatingTaskId(null);
    }
  };

  const highPriorityCount = tasks.filter((task) => ["critical", "high"].includes(task.severity)).length;
  const climateCount = tasks.filter((task) => task.kind === "climate").length;
  const irrigationCount = tasks.filter((task) => task.kind === "irrigation").length;

  return (
    <PageShell
      title="Farm Action Plan"
      subtitle="Prioritized actions from your climate alerts, pest reports, and irrigation schedule."
      badge="Your next steps"
      icon={<ClipboardCheck className="h-6 w-6" />}
      actions={(
        <Button variant="outline" onClick={loadTasks} disabled={loading} className="gap-2">
          <LoaderCircle className={`h-4 w-4 ${loading ? "animate-spin" : "hidden"}`} />
          Refresh plan
        </Button>
      )}
    >
      <section className="grid gap-4 sm:grid-cols-3" aria-label="Action plan summary">
        <Card className="motion-safe:animate-fade-in-up" style={{ animationDelay: "0ms" }}>
          <CardContent className="flex items-center justify-between p-5">
            <div><p className="text-sm text-muted-foreground">Open actions</p><p className="mt-1 text-3xl font-semibold">{tasks.length}</p></div>
            <ClipboardCheck className="h-5 w-5 text-primary" />
          </CardContent>
        </Card>
        <Card className="motion-safe:animate-fade-in-up" style={{ animationDelay: "80ms" }}>
          <CardContent className="flex items-center justify-between p-5">
            <div><p className="text-sm text-muted-foreground">High priority</p><p className="mt-1 text-3xl font-semibold">{highPriorityCount}</p></div>
            <AlertTriangle className="h-5 w-5 text-destructive" />
          </CardContent>
        </Card>
        <Card className="motion-safe:animate-fade-in-up" style={{ animationDelay: "160ms" }}>
          <CardContent className="flex items-center justify-between p-5">
            <div><p className="text-sm text-muted-foreground">Irrigation due</p><p className="mt-1 text-3xl font-semibold">{irrigationCount}</p></div>
            <Droplets className="h-5 w-5 text-[hsl(var(--sky))]" />
          </CardContent>
        </Card>
      </section>

      {loading ? (
        <div className="flex items-center justify-center gap-3 py-16 text-muted-foreground" role="status">
          <LoaderCircle className="h-5 w-5 animate-spin" /> Loading your action plan...
        </div>
      ) : farms.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-14 text-center">
            <Sprout className="mb-4 h-10 w-10 text-primary" />
            <h2 className="text-xl font-semibold">Add a farm to get started</h2>
            <p className="mt-2 max-w-md text-sm text-muted-foreground">Your action plan gathers recommendations from farms you manage.</p>
            <Button className="mt-5" onClick={() => navigate("/manage-farms")}>Manage farms</Button>
          </CardContent>
        </Card>
      ) : sortedTasks.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-14 text-center">
            <Check className="mb-4 h-10 w-10 text-primary" />
            <h2 className="text-xl font-semibold">You’re all caught up</h2>
            <p className="mt-2 max-w-md text-sm text-muted-foreground">No unread climate alerts, open pest reports, or irrigation tasks are due today.</p>
            <Button variant="outline" className="mt-5" onClick={() => navigate("/dashboard")}>Back to dashboard</Button>
          </CardContent>
        </Card>
      ) : (
        <section className="space-y-3" aria-label="Farm actions">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">Recommended next steps</h2>
              <p className="text-sm text-muted-foreground">{climateCount} climate alerts · {tasks.filter((task) => task.kind === "pest").length} pest reports · {irrigationCount} irrigation tasks</p>
            </div>
          </div>
          {sortedTasks.map((task, index) => {
            const Icon = taskIcons[task.kind];
            return (
              <Card
                key={`${task.kind}-${task.id}`}
                className="transition-colors hover:border-primary/40 motion-safe:animate-fade-in-up"
                style={{ animationDelay: `${Math.min(index * 70, 420)}ms` }}
              >
                <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start sm:p-5">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                    <Icon className="h-5 w-5 text-primary" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-semibold">{task.title}</h3>
                      <Badge variant={severityVariants[task.severity] || "outline"}>{task.severity}</Badge>
                      <Badge variant="outline">{task.farmName}</Badge>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">{task.description}</p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {task.kind === "irrigation" ? "Due" : task.kind === "climate" ? "Forecast" : "Detected"}: {new Date(task.dueDate).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2 sm:flex-col">
                    <Button variant="outline" size="sm" className="gap-1.5" onClick={() => navigate(task.href)}>
                      Review <ArrowUpRight className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="sm" className="gap-1.5" onClick={() => completeTask(task)} disabled={updatingTaskId === task.id}>
                      {updatingTaskId === task.id ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                      Done
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </section>
      )}
    </PageShell>
  );
};

export default FarmActionPlan;

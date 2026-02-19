export interface GrafanaWebhookPayload {
  receiver: string;
  status: 'firing' | 'resolved';
  alerts: GrafanaAlert[];
  groupLabels: Record<string, string>;
  commonLabels: Record<string, string>;
  commonAnnotations: Record<string, string>;
  externalURL: string;
  version: string;
  groupKey: string;
  truncatedAlerts: number;
  orgId: number;
  title: string;
  state: string;
  message: string;
}

export interface GrafanaAlert {
  status: 'firing' | 'resolved';
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt: string;
  endsAt: string;
  generatorURL: string;
  fingerprint: string;
  silenceURL: string;
  dashboardURL: string;
  panelURL: string;
  values: Record<string, number> | null;
  valueString: string;
}

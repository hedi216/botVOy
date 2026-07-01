export type MissionConfig = {
  targetUrl: string;
  loginEmail: string;
  loginPassword: string;
  applicationCentre: string;
  appointmentCategory: string;
  subCategory: string;
  firstName: string;
  lastName: string;
  currentNationality: string;
  passportNumber: string;
  phoneDialCode: string;
  phoneNumber: string;
  applicantEmail: string;
  checkIntervalMinutes: number;
  afterSaveWaitSeconds: number;
  afterDateClickWaitSeconds: number;
  servicesWaitSeconds: number;
  notificationEmail: string;
  smtpHost?: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser?: string;
  smtpPass?: string;
  browserChannel?: string;
  userDataDir?: string;
  slowMoMs: number;
  headless: boolean;
  humanPauseTimeoutMinutes: number;
  enableAiAssistant: boolean;
  openAiApiKey?: string;
  aiModel: string;
};

export type HumanValidationResult = {
  detected: boolean;
  reason?: string;
};

export type AiPageAnalysis = {
  understood: boolean;
  summary: string;
  suggestedAction?: string;
  risk?: string;
};

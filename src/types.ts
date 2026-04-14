export interface LineItem {
  purchase_number: number;
  category: string;
  type: string;
  description: string;
  purchase_date: string;
  quantity: number;
  cost: number;
  tax_shipping: number;
  vendor: string;
  approval_status: string;
  denial_reason: string;
  invoice_number: string;
  educational_benefit: string;
  item_url: string;
  // Status tracking
  status_changed_at?: string;
  previous_status?: string;
}

export interface Transaction {
  id: string;
  date: string;
  type: string;
  amount: number;
  vendor: string;
  category: string;
  status: string;
  description: string;
  student: string;
  extracted_at: string;
  // Status tracking
  status_changed_at?: string;
  previous_status?: string;
  // Detail fields (populated from detail page)
  detail_url?: string;
  line_items?: LineItem[];
  has_denials?: boolean;
  details_extracted?: boolean;
}

export interface BalanceSnapshot {
  date: string;
  total_balance: number;
  available_balance: number;
  pending_amount: number;
  extracted_at: string;
}

export interface TransactionStore {
  version: 1;
  last_extract: string | null;
  transactions: Transaction[];
}

export interface BalanceStore {
  version: 1;
  snapshots: BalanceSnapshot[];
}

export interface TrackerConfig {
  portal_url: string;
  auth_state_path: string;
  browser_path: string;
  data_dir: string;
  headless: boolean;
}

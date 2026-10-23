use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NavigationRequest {
    pub url: String,
    pub tab_id: String,
    pub navigation_id: u64,
}

use odra::prelude::*;
use odra::casper_types::{PublicKey, U512};

#[odra::odra_type]
pub enum ArenaMatchStatus {
    Pending,
    Active,
    Settled,
}

#[odra::event]
pub struct MatchCreated {
    pub match_id: u64,
    pub creator: Address,
    pub agent_a: PublicKey,
    pub agent_b: PublicKey,
    pub verifier: PublicKey,
    pub market_id: String,
    pub rules_hash: String,
    pub start_budget: U512,
    pub end_time: u64,
}

#[odra::event]
pub struct MatchStarted {
    pub match_id: u64,
    pub start_time: u64,
    pub end_time: u64,
}

#[odra::event]
pub struct TradeRecorded {
    pub match_id: u64,
    pub agent: Address,
    pub action: String,
    pub amount: U512,
    pub price: U512,
    pub portfolio_value: U512,
    pub reasoning_hash: String,
    pub evidence_hash: String,
    pub block_time: u64,
}

#[odra::event]
pub struct MatchSettled {
    pub match_id: u64,
    pub winner: Option<PublicKey>,
    pub value_a: U512,
    pub value_b: U512,
    pub settlement_hash: String,
    pub block_time: u64,
}

#[odra::module(events = [MatchCreated, MatchStarted, TradeRecorded, MatchSettled])]
pub struct ArenaContractModule {
    next_match_id: Var<u64>,
    creator: Mapping<u64, Address>,
    agent_a: Mapping<u64, PublicKey>,
    agent_b: Mapping<u64, PublicKey>,
    verifier: Mapping<u64, PublicKey>,
    market_id: Mapping<u64, String>,
    rules_hash: Mapping<u64, String>,
    start_time: Mapping<u64, u64>,
    end_time: Mapping<u64, u64>,
    start_budget: Mapping<u64, U512>,
    status: Mapping<u64, ArenaMatchStatus>,
    value_a: Mapping<u64, U512>,
    value_b: Mapping<u64, U512>,
    trade_count: Mapping<u64, u32>,
    winner: Mapping<u64, Option<PublicKey>>,
    settlement_hash: Mapping<u64, String>,
}

#[odra::module]
impl ArenaContractModule {
    pub fn create_match(
        &mut self,
        agent_a: PublicKey,
        agent_b: PublicKey,
        verifier: PublicKey,
        duration_ms: u64,
        start_budget: U512,
        market_id: String,
        rules_hash: String,
    ) -> u64 {
        self.require(duration_ms > 0, "duration must be positive");
        self.require(!start_budget.is_zero(), "start budget must be positive");
        self.require(agent_a != agent_b, "agent accounts must be distinct");
        self.require(!market_id.is_empty(), "market is required");
        self.require(!rules_hash.is_empty(), "rules hash is required");

        let id = self.next_match_id.get_or_default() + 1;
        let now = self.env().get_block_time();
        let creator = self.env().caller();
        let end_time = now.saturating_add(duration_ms);

        self.next_match_id.set(id);
        self.creator.set(&id, creator);
        self.agent_a.set(&id, agent_a.clone());
        self.agent_b.set(&id, agent_b.clone());
        self.verifier.set(&id, verifier.clone());
        self.market_id.set(&id, market_id.clone());
        self.rules_hash.set(&id, rules_hash.clone());
        self.start_time.set(&id, now);
        self.end_time.set(&id, end_time);
        self.start_budget.set(&id, start_budget);
        self.status.set(&id, ArenaMatchStatus::Pending);
        self.value_a.set(&id, start_budget);
        self.value_b.set(&id, start_budget);
        self.trade_count.set(&id, 0);
        self.winner.set(&id, None);

        self.env().emit_event(MatchCreated {
            match_id: id,
            creator,
            agent_a,
            agent_b,
            verifier,
            market_id,
            rules_hash,
            start_budget,
            end_time,
        });
        id
    }

    pub fn start_match(&mut self, match_id: u64) {
        self.require_status(match_id, ArenaMatchStatus::Pending, "match is not pending");
        let caller = self.env().caller();
        self.require(
            caller == self.creator_of(match_id) || caller == Address::from(self.verifier_of(match_id)),
            "unauthorized start caller",
        );

        let now = self.env().get_block_time();
        let duration = self.end_time.get(&match_id).unwrap_or_default()
            .saturating_sub(self.start_time.get(&match_id).unwrap_or_default());
        let end_time = now.saturating_add(duration);
        self.start_time.set(&match_id, now);
        self.end_time.set(&match_id, end_time);
        self.status.set(&match_id, ArenaMatchStatus::Active);
        self.env().emit_event(MatchStarted { match_id, start_time: now, end_time });
    }

    pub fn record_trade(
        &mut self,
        match_id: u64,
        action: String,
        amount: U512,
        price: U512,
        portfolio_value: U512,
        reasoning_hash: String,
        evidence_hash: String,
    ) {
        self.require_status(match_id, ArenaMatchStatus::Active, "match is not active");
        self.require(!action.is_empty(), "action is required");
        self.require(!reasoning_hash.is_empty(), "reasoning hash is required");
        self.require(!evidence_hash.is_empty(), "evidence hash is required");
        self.require(self.env().get_block_time() <= self.end_time.get(&match_id).unwrap_or_default(), "match already ended");

        let agent = self.env().caller();
        self.require(agent == Address::from(self.agent_a_of(match_id)) || agent == Address::from(self.agent_b_of(match_id)), "unauthorized agent");
        if agent == Address::from(self.agent_a_of(match_id)) {
            self.value_a.set(&match_id, portfolio_value);
        } else {
            self.value_b.set(&match_id, portfolio_value);
        }
        let count = self.trade_count.get(&match_id).unwrap_or_default() + 1;
        self.trade_count.set(&match_id, count);
        self.env().emit_event(TradeRecorded {
            match_id,
            agent,
            action,
            amount,
            price,
            portfolio_value,
            reasoning_hash,
            evidence_hash,
            block_time: self.env().get_block_time(),
        });
    }

    pub fn settle_match(&mut self, match_id: u64, settlement_hash: String) -> Option<PublicKey> {
        self.require_status(match_id, ArenaMatchStatus::Active, "match is not active");
        self.require(!settlement_hash.is_empty(), "settlement hash is required");
        self.require(self.env().caller() == Address::from(self.verifier_of(match_id)), "unauthorized verifier");
        self.require(self.env().get_block_time() >= self.end_time.get(&match_id).unwrap_or_default(), "too early to settle");

        let value_a = self.value_a.get(&match_id).unwrap_or_default();
        let value_b = self.value_b.get(&match_id).unwrap_or_default();
        let winner = if value_a > value_b {
            Some(self.agent_a_of(match_id))
        } else if value_b > value_a {
            Some(self.agent_b_of(match_id))
        } else {
            None
        };
        self.status.set(&match_id, ArenaMatchStatus::Settled);
        self.winner.set(&match_id, winner.clone());
        self.settlement_hash.set(&match_id, settlement_hash.clone());
        self.env().emit_event(MatchSettled {
            match_id,
            winner: winner.clone(),
            value_a,
            value_b,
            settlement_hash,
            block_time: self.env().get_block_time(),
        });
        winner
    }

    pub fn get_status(&self, match_id: u64) -> Option<ArenaMatchStatus> { self.status.get(&match_id) }
    pub fn get_value_a(&self, match_id: u64) -> U512 { self.value_a.get(&match_id).unwrap_or_default() }
    pub fn get_value_b(&self, match_id: u64) -> U512 { self.value_b.get(&match_id).unwrap_or_default() }
    pub fn get_trade_count(&self, match_id: u64) -> u32 { self.trade_count.get(&match_id).unwrap_or_default() }
    pub fn get_winner(&self, match_id: u64) -> Option<PublicKey> { self.winner.get(&match_id).unwrap_or_default() }
    pub fn get_end_time(&self, match_id: u64) -> u64 { self.end_time.get(&match_id).unwrap_or_default() }

    fn creator_of(&self, match_id: u64) -> Address { self.creator.get(&match_id).unwrap_or_else(|| self.fail()) }
    fn agent_a_of(&self, match_id: u64) -> PublicKey { self.agent_a.get(&match_id).unwrap_or_else(|| self.fail()) }
    fn agent_b_of(&self, match_id: u64) -> PublicKey { self.agent_b.get(&match_id).unwrap_or_else(|| self.fail()) }
    fn verifier_of(&self, match_id: u64) -> PublicKey { self.verifier.get(&match_id).unwrap_or_else(|| self.fail()) }

    fn require_status(&self, match_id: u64, expected: ArenaMatchStatus, message: &str) {
        self.require(self.status.get(&match_id) == Some(expected), message);
    }

    fn require(&self, condition: bool, _message: &str) {
        if !condition { self.fail(); }
    }

    fn fail(&self) -> ! {
        #[cfg(target_arch = "wasm32")]
        self.env().revert(OdraError::user(1));
        #[cfg(not(target_arch = "wasm32"))]
        self.env().revert(OdraError::user(1, "arena contract validation failed"));
    }
}

#[cfg(test)]
mod odra_tests {
    use super::*;
    use odra::host::{Deployer, HostEnv, NoArgs};

    fn deploy() -> (HostEnv, ArenaContractModuleHostRef) {
        let env = odra_test::env();
        let contract = ArenaContractModule::deploy(&env, NoArgs);
        (env, contract)
    }

    #[test]
    fn caller_and_time_control_match_lifecycle() {
        let (env, mut arena) = deploy();
        let creator = env.get_account(0);
        let alpha = env.public_key(&env.get_account(1));
        let beta = env.public_key(&env.get_account(2));
        let verifier = env.public_key(&env.get_account(3));
        env.set_caller(creator);
        let id = arena.create_match(alpha.clone(), beta, verifier.clone(), 1_000, U512::from(1_000), "CSPR/sCSPR/TREASURY".into(), "rules".into());
        arena.start_match(id);
        env.set_caller(Address::from(alpha.clone()));
        arena.record_trade(id, "BUY".into(), U512::from(100), U512::from(1_000), U512::from(1_050), "reason".into(), "evidence".into());
        env.set_caller(Address::from(verifier));
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| arena.settle_match(id, "settle".into()))).is_err());
        env.advance_block_time(1_000);
        assert_eq!(arena.settle_match(id, "settle".into()), Some(alpha));
    }
}

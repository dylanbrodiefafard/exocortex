#include "ledger.hpp"

namespace bank {

Ledger::Account& Ledger::get(const std::string& id) {
    auto it = accounts_.find(id);
    if (it == accounts_.end()) throw std::out_of_range("no such account: " + id);
    return it->second;
}

const Ledger::Account& Ledger::get(const std::string& id) const {
    auto it = accounts_.find(id);
    if (it == accounts_.end()) throw std::out_of_range("no such account: " + id);
    return it->second;
}

void Ledger::open(const std::string& id, Cents overdraft_limit) {
    Account account;
    account.overdraft_limit = overdraft_limit;
    accounts_[id] = account;
}

void Ledger::deposit(const std::string& id, Cents amount) {
    Account& a = get(id);
    a.balance += amount;
    a.entries.push_back({next_seq_++, Kind::Deposit, amount, a.balance, ""});
}

void Ledger::withdraw(const std::string& id, Cents amount) {
    Account& a = get(id);
    if (a.balance < amount) throw InsufficientFunds("insufficient funds in " + id);
    a.balance -= amount;
    a.entries.push_back({next_seq_++, Kind::Withdrawal, -amount, a.balance, ""});
}

void Ledger::transfer(const std::string& from, const std::string& to, Cents amount) {
    Account& src = get(from);
    if (src.balance < amount) throw InsufficientFunds("insufficient funds in " + from);
    src.balance -= amount;
    src.entries.push_back({next_seq_++, Kind::TransferOut, -amount, src.balance, to});
    Account& dst = get(to);
    dst.balance += amount;
    dst.entries.push_back({next_seq_++, Kind::TransferIn, amount, dst.balance, from});
}

void Ledger::split(const std::string&, const std::vector<std::string>&, Cents) {
    throw std::logic_error("split: not implemented");
}

void Ledger::apply_interest(const std::string& id, int basis_points) {
    Account& a = get(id);
    Cents interest = a.balance * basis_points / 10000;
    a.balance += interest;
    a.entries.push_back({next_seq_++, Kind::Interest, interest, a.balance, ""});
}

Cents Ledger::balance(const std::string& id) const { return get(id).balance; }

std::vector<Entry> Ledger::history(const std::string& id) const { return get(id).entries; }

std::string Ledger::statement(const std::string&) const {
    throw std::logic_error("statement: not implemented");
}

}  // namespace bank

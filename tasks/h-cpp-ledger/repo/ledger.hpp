// An in-memory ledger of bank accounts.
#pragma once

#include <map>
#include <stdexcept>
#include <string>
#include <vector>

#include "money.hpp"

namespace bank {

// Thrown when a withdrawal or transfer would exceed the account's overdraft limit.
class InsufficientFunds : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

enum class Kind { Deposit, Withdrawal, TransferIn, TransferOut, Interest };

struct Entry {
    long long seq;             // ledger-wide sequence number of the operation
    Kind kind;
    Cents amount;              // signed: positive increases the balance
    Cents balance_after;       // account balance after this entry
    std::string counterparty;  // other account for transfers, empty otherwise
};

class Ledger {
public:
    void open(const std::string& id, Cents overdraft_limit = 0);
    void deposit(const std::string& id, Cents amount);
    void withdraw(const std::string& id, Cents amount);
    void transfer(const std::string& from, const std::string& to, Cents amount);
    void split(const std::string& from, const std::vector<std::string>& to, Cents amount);
    void apply_interest(const std::string& id, int basis_points);

    Cents balance(const std::string& id) const;
    std::vector<Entry> history(const std::string& id) const;
    std::string statement(const std::string& id) const;

private:
    struct Account {
        Cents balance = 0;
        Cents overdraft_limit = 0;
        std::vector<Entry> entries;
    };

    Account& get(const std::string& id);
    const Account& get(const std::string& id) const;

    std::map<std::string, Account> accounts_;
    long long next_seq_ = 1;
};

}  // namespace bank

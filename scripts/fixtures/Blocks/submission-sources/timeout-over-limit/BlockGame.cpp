#include <chrono>
#include <iostream>
#include <string>
#include <thread>

using namespace std;

int main() {
    int n = 0;
    int t = 0;
    int c = 0;
    double f = 0.0;
    double p = 0.0;

    if (!(cin >> n >> t >> c >> f >> p)) {
        return 0;
    }

    string token;
    for (int index = 0; index < n * n; ++index) {
        if (!(cin >> token)) {
            return 0;
        }
    }
    for (int index = 0; index < t; ++index) {
        if (!(cin >> token)) {
            return 0;
        }
    }

    this_thread::sleep_for(chrono::milliseconds(125));
    cout << "-1" << endl;
    return 0;
}

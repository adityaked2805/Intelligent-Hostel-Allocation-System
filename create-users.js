const usersToCreate = [];
let studentCount = 1;

const prefixes = [
    { prefix: '23UCS', program: 'CSE' },
    { prefix: '23UCC', program: 'CCE' },
    { prefix: '23UEC', program: 'ECE' },
    { prefix: '23UME', program: 'ME' }
];

for (const p of prefixes) {
    for (let i = 1; i <= 10; i++) {
        const rollNumber = `${p.prefix}${i.toString().padStart(3, '0')}`;
        usersToCreate.push({
            email: `student${studentCount}@example.com`,
            password: 'student',
            role: 'student',
            rollNumber: rollNumber,
            fullName: `Student ${studentCount}`,
            year: 2,
            gender: 'male',
            program: p.program
        });
        studentCount++;
    }
}

async function createUsers() {
    console.log(`Creating ${usersToCreate.length} students...`);
    for (const user of usersToCreate) {
        try {
            const res = await fetch('http://localhost:3000/auth/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(user)
            });
            if (res.ok) {
                console.log(`Successfully created ${user.fullName} (${user.rollNumber})`);
            } else if (res.status === 409) {
                console.log(`User ${user.rollNumber} or email already exists. Skipping.`);
            } else {
                const text = await res.text();
                console.error(`Failed to create ${user.fullName}: ${res.status} - ${text}`);
            }
        } catch (err) {
            console.error(`Error connecting to API for ${user.fullName}:`, err.message);
        }
    }
    console.log('Done.');
}

createUsers();

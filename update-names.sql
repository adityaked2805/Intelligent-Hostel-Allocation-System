UPDATE students 
SET "fullName" = REPLACE("fullName", 'Student ', 'Student 0') 
WHERE "fullName" IN ('Student 1', 'Student 2', 'Student 3', 'Student 4', 'Student 5', 'Student 6', 'Student 7', 'Student 8', 'Student 9');
